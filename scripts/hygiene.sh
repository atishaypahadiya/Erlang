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
# prefix such as ".cache/". This is the format KERCKHOFFS reads too. Without the file the check
# is skipped, with a notice.
#
# Writing about automated tools as a subject is fine; the terms should match
# claims of authorship (trailers, "generated with ...") and nothing broader.
#
# The hooks in scripts/hooks call it; run scripts/setup.sh once per clone to
# enable them. Whether or not the terms file exists, the terms file itself (or
# a link to it, or a backup of it) is never allowed into a commit.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
terms_file="$root/.erlang-private-terms"
mode=${1:-}

# The terms file, its link and its backups never enter the repository,
# whatever the terms say. Checked before anything else, even without the file.
if [[ ${1:-} == staged ]]; then
  list=$(git diff --cached --name-only --diff-filter=ACMR)
elif [[ ${1:-} == all ]]; then
  list=$(git ls-files)
else
  list=""
fi
if leaked=$(printf '%s\n' "$list" | grep -E '(^|/)\.[a-z]+-private-terms' ); then
  while IFS= read -r path; do echo "hygiene: $path holds private terms and must not be committed" >&2; done <<< "$leaked"
  exit 1
fi

if [[ ! -f $terms_file ]]; then
  echo "hygiene: skipped, .erlang-private-terms not found (run scripts/setup.sh)" >&2
  exit 0
fi

# A leading "subject " marks a pattern banned even as a subject, not only as
# an authorship claim. Repositories with an allowlist may relax those; this one
# has none, so they are enforced like the rest, with the marker removed.
terms=$(grep -v -E '^[[:space:]]*(#|$)' "$terms_file" | grep -v -E '^private ' | sed -E 's/^[[:space:]]*subject[[:space:]]+//' || true)
private=$(grep -E '^private ' "$terms_file" | sed -e 's/^private //' || true)

failed=0
fail() { echo "hygiene: $*" >&2; failed=1; }

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

# Check a path against the "private" lines. $2, if given, labels the report.
check_path() {
  local path=$1 label=${2:-$1} p
  [[ -n $private ]] || return 0
  while IFS= read -r p; do
    [[ -n $p ]] || continue
    if [[ $path == "$p" || $path == "$p"* ]]; then
      fail "$label is private and must not be committed"
      return 0
    fi
  done <<< "$private"
}

# Paths no commit may hold at any depth, whatever the terms file says: the
# terms file and its link or backups, the private instructions file, and the
# private settings folder. Written as character classes so this file does not
# name them.
always_private='(^|/)\.[a-z]+-private-terms|(^|/)CL[A]UDE(\.local)?\.md$|(^|/)\.cl[a]ude/'


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
        if printf '%s\n' "$path" | grep -q -i -E "$always_private"; then
          fail "$short:$path is private and must not be committed"
        else
          check_path "$path" "$short:$path"
        fi
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
