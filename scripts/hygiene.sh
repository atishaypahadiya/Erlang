#!/usr/bin/env bash
# Refuse commits that claim automated authorship or track private files.
#
# Usage:
#   scripts/hygiene.sh staged          check the files staged for commit (pre-commit hook)
#   scripts/hygiene.sh message <file>  check a commit message (commit-msg hook)
#   scripts/hygiene.sh all             check every tracked file and every commit message
#
# The terms live in .erlang-private-terms, a local file kept out of the
# repository, so this script does not carry the words it looks for. One
# case-insensitive extended regular expression per line; blank lines and lines
# starting with # are ignored. Lines starting with "private " hold a regular
# expression for paths that must never be committed. Without the file the check
# is skipped, with a notice.
#
# Writing about automated tools as a subject is fine; the terms should match
# claims of authorship (trailers, "generated with ...") and nothing broader.
#
# Install the hooks once per clone:
#   printf '#!/usr/bin/env bash\nexec scripts/hygiene.sh staged\n' > .git/hooks/pre-commit
#   printf '#!/usr/bin/env bash\nexec scripts/hygiene.sh message "$1"\n' > .git/hooks/commit-msg
#   chmod +x .git/hooks/pre-commit .git/hooks/commit-msg
set -euo pipefail

root=$(git rev-parse --show-toplevel)
terms_file="$root/.erlang-private-terms"
mode=${1:-}

if [[ ! -f $terms_file ]]; then
  echo "hygiene: skipped, .erlang-private-terms not found" >&2
  exit 0
fi

terms=$(grep -v -E '^[[:space:]]*(#|$)' "$terms_file" | grep -v -E '^private ' || true)
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

check_path() {
  local path=$1
  if [[ -n $private ]] && printf '%s\n' "$path" | grep -q -E -f <(printf '%s\n' "$private"); then
    fail "$path is private and must not be committed"
  fi
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
  *)
    echo "usage: hygiene.sh staged | message <file> | all" >&2
    exit 2
    ;;
esac

exit "$failed"
