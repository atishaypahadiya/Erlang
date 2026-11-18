#!/usr/bin/env bash
# Refuse commits that claim automated authorship or track private files.
#
# Usage:
#   scripts/hygiene.sh staged          check the files staged for commit (pre-commit hook)
#   scripts/hygiene.sh message <file>  check a commit message (commit-msg hook)
#   scripts/hygiene.sh all             check every tracked file and every commit message
#   scripts/hygiene.sh history [revs]  check every file at every commit in revs (default
#                                      main) and each commit's message; run it on
#                                      origin/main..main before a push
#
# The terms live in .erlang-private-terms, kept out of the repository, so this
# script does not carry the words it looks for. scripts/setup.sh makes it a link
# to the file the specialists share, ~/.config/specialists/private-terms. One
# case-insensitive extended regular expression per line; blank lines and lines
# starting with # are ignored. Lines starting with "private " name a path that
# must never be committed: the path itself, or anything under it when it is a
# prefix such as ".cache/". This is the format KERCKHOFFS reads too. Without
# the file the content scan is skipped, with a notice; the built-in path
# refusals below still run.
#
# Writing about automated tools as a subject is fine; the terms should match
# claims of authorship (trailers, "generated with ...") and nothing broader.
# Lines starting with "subject " are the exception: bare names banned even as
# a subject. A repository may allow some of them where it must name them, by
# listing them in .private-terms-allow at its root (in the working tree), one
# per line, written exactly as after "subject " in the terms file; blank lines
# and lines starting with # are ignored. Only subject terms can be allowed. An
# authorship pattern listed there stays enforced, and the run fails, saying
# so. An entry that matches no term is reported and ignored. The allowlist
# applies to every mode.
#
# The hooks in scripts/hooks call it; run scripts/setup.sh once per clone to
# enable them. Whether or not the terms file exists, no commit may hold a
# private terms file (or a link to it, or a backup of it), the private
# instructions file or the private settings folder.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
terms_file="$root/.erlang-private-terms"
mode=${1:-}

# Paths no commit may hold at any depth, whatever the terms file says or
# whether it exists: any private terms file, its link or backups
# (private-terms, .erlang-private-terms, private-terms.bak1), the private
# instructions file and the private settings folder. Written as character
# classes so this file does not name them. The same list as KERCKHOFFS's.
always_private='(^|/)([^/]*-)?private-terms|(^|/)CL[A]UDE(\.local)?\.md$|(^|/)\.cl[a]ude/'

terms=""
private=""
if [[ ! -f $terms_file ]]; then
  if [[ -L $terms_file ]]; then
    echo "hygiene: .erlang-private-terms links to $(readlink "$terms_file"), which does not exist; content not scanned, only built-in private paths checked; run scripts/setup.sh" >&2
  else
    echo "hygiene: .erlang-private-terms not found; content not scanned, only built-in private paths checked; run scripts/setup.sh" >&2
  fi
else
  # A leading "subject " marks a pattern banned even as a subject, not only as
  # an authorship claim; only those may be allowed (above).
  patterns=$(grep -v -E '^[[:space:]]*(#|$)' "$terms_file" | grep -v -E '^private ' || true)
  subjects=$(grep -E '^[[:space:]]*subject[[:space:]]+' <<< "$patterns" | sed -E 's/^[[:space:]]*subject[[:space:]]+//' || true)
  authorship=$(grep -v -E '^[[:space:]]*subject[[:space:]]+' <<< "$patterns" || true)
  private=$(grep -E '^private ' "$terms_file" | sed -e 's/^private //' || true)
fi

failed=0
fail() { echo "hygiene: $*" >&2; failed=1; }

# The allowlist. Entries are compared as whole lines, and reported by line
# number, so this output does not repeat the terms.
allow_file="$root/.private-terms-allow"
allowed=""
if [[ -f $allow_file && -f $terms_file ]]; then
  n=0
  while IFS= read -r entry || [[ -n $entry ]]; do
    n=$((n + 1))
    entry=$(sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' <<< "$entry")
    [[ -z $entry || $entry == \#* ]] && continue
    if grep -q -x -F -e "$entry" <<< "$subjects"; then
      allowed+="$entry"$'\n'
    elif grep -q -x -F -e "$entry" <<< "$authorship"; then
      fail ".private-terms-allow line $n lists an authorship pattern; authorship patterns are never allowed, so it stays enforced"
    else
      echo "hygiene: .private-terms-allow line $n matches no subject term in the terms file; ignored" >&2
    fi
  done < "$allow_file"
fi

# The patterns enforced: every authorship pattern, and every subject term not
# allowed.
if [[ -f $terms_file ]]; then
  terms=$( { printf '%s\n' "$authorship"; grep -v -x -F -f <(printf '%s' "$allowed") <<< "$subjects" || true; } | grep -v -E '^$' || true)
  [[ -n $allowed ]] || terms=$(printf '%s\n%s\n' "$authorship" "$subjects" | grep -v -E '^$' || true)
fi

# Report each matching line of the text on stdin, labelled with $1. Callers
# redirect into it rather than pipe, so that fail runs in this shell.
scan() {
  local label=$1
  [[ -n $terms ]] || { cat > /dev/null; return 0; }
  local hits
  hits=$(grep -n -i -E -f <(printf '%s\n' "$terms") || true)
  if [[ -n $hits ]]; then
    while IFS= read -r hit; do
      fail "$label:${hit%%:*} matches a private term: ${hit#*:}"
    done <<< "$hits"
  fi
}

# Check a path against the built-in private paths and the "private" lines.
# $2, if given, labels the report.
check_path() {
  local path=$1 label=${2:-$1} p
  if printf '%s\n' "$path" | grep -q -i -E "$always_private"; then
    fail "$label is private and must not be committed"
    return 0
  fi
  [[ -n $private ]] || return 0
  while IFS= read -r p; do
    [[ -n $p ]] || continue
    if [[ $path == "$p" || $path == "$p"* ]]; then
      fail "$label is private and must not be committed"
      return 0
    fi
  done <<< "$private"
}


case $mode in
  staged)
    while IFS= read -r -d '' path; do
      check_path "$path"
      # Skip binary files: numstat shows "-" for them.
      if git diff --cached --numstat -- "$path" | grep -q -E '^-'; then continue; fi
      scan "$path" < <(git show ":$path")
    done < <(git diff --cached --name-only --diff-filter=ACMR -z)
    ;;
  message)
    file=${2:?usage: hygiene.sh message <file>}
    scan "commit message" < <(grep -v -E '^#' "$file" || true)
    ;;
  all)
    while IFS= read -r -d '' path; do
      check_path "$path"
      [[ -f $root/$path ]] || continue
      if grep -q -I '' "$root/$path" 2>/dev/null || [[ ! -s $root/$path ]]; then
        scan "$path" < "$root/$path"
      fi
    done < <(git ls-files -z)
    if git rev-parse -q --verify HEAD > /dev/null; then
      while IFS= read -r hash; do
        scan "commit ${hash:0:7}" < <(git log -1 --format=%B "$hash")
      done < <(git rev-list HEAD)
    fi
    ;;
  history)
    revs=${2:-main}
    git rev-parse -q --verify "${revs##*..}^{commit}" > /dev/null || { echo "hygiene: no such revision: $revs" >&2; exit 2; }
    commits=$(git rev-list "$revs")
    [[ -n $commits ]] || { echo "hygiene: no commits in $revs" >&2; exit 0; }
    seen=" "
    while IFS= read -r hash; do
      short=${hash:0:7}
      scan "commit $short message" < <(git log -1 --format=%B "$hash")
      while IFS= read -r -d '' entry; do
        meta=${entry%%$'\t'*}
        path=${entry#*$'\t'}
        blob=${meta##* }
        check_path "$path" "$short:$path"
        # Scan each distinct content once, under the first commit that has it.
        [[ $seen == *" $blob "* ]] && continue
        seen="$seen$blob "
        if git cat-file blob "$blob" | grep -q -I ''; then
          scan "$short:$path" < <(git cat-file blob "$blob")
        fi
      done < <(git ls-tree -r -z "$hash")
    done <<< "$commits"
    echo "hygiene: history of $revs checked ($(printf '%s\n' "$commits" | wc -l | tr -d ' ') commits)" >&2
    ;;
  *)
    echo "usage: hygiene.sh staged | message <file> | all | history [revs]" >&2
    exit 2
    ;;
esac

exit "$failed"
