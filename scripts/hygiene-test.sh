#!/usr/bin/env bash
# Tests scripts/hygiene.sh's per-repository allowlist (.private-terms-allow) in
# every mode: staged, message, all and history. Each case builds a scratch git
# repository under dist/hygiene-test/ with a terms file of made-up terms, so no
# real term appears here:
#   subject zorblax         a bare name, which a repository may allow
#   made by zorbot          an authorship pattern, which none may
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
HYG="$ROOT/scripts/hygiene.sh"
OUT="$ROOT/dist/hygiene-test"
rm -rf "$OUT"
mkdir -p "$OUT"

SUBJECT='zorblax'
AUTHORSHIP='made by zorbot'
failed=0
git_() { git -c core.hooksPath=/dev/null -c user.name=test -c user.email=test@example.invalid "$@"; }

# A repository with the terms file (untracked, as in a real clone), and, when
# $2 is given, a committed .private-terms-allow holding it.
repo() {
  local dir="$OUT/$1"
  mkdir -p "$dir"
  git_ -C "$dir" init -q -b main
  printf '# made-up terms\nsubject %s\n%s\nprivate secrets/\n' "$SUBJECT" "$AUTHORSHIP" > "$dir/.erlang-private-terms"
  printf 'a test repository\n' > "$dir/README.md"
  git_ -C "$dir" add README.md
  if [[ -n ${2:-} ]]; then
    printf '# allowed here\n%s\n' "$2" > "$dir/.private-terms-allow"
    git_ -C "$dir" add .private-terms-allow
  fi
  git_ -C "$dir" commit -q -m 'start'
  echo "$dir"
}

# Runs hygiene in $dir with the remaining arguments; sets $code and $err.
run() {
  local dir=$1; shift
  set +e
  err=$(cd "$dir" && bash "$HYG" "$@" 2>&1 >/dev/null)
  code=$?
  set -e
}

# expect <label> <pass|fail> [text the output must hold]
expect() {
  local label=$1 want=$2 needle=${3:-}
  local ok=1
  if [[ $want == pass ]]; then [[ $code -eq 0 ]] || ok=0; else [[ $code -ne 0 ]] || ok=0; fi
  if [[ -n $needle && $err != *"$needle"* ]]; then ok=0; fi
  if [[ $ok -eq 1 ]]; then
    echo "PASS  $label  (exit $code)"
  else
    echo "FAIL  $label  (exit $code; output: ${err//$'\n'/ | })"
    failed=1
  fi
}

# One case in all four modes: the text appears in a staged file, in a commit
# message, and then, committed, in the tree and history.
# case <name> <allow entry or ""> <text> <pass|fail> [needle]
case_() {
  local name=$1 allow=$2 text=$3 want=$4 needle=${5:-}
  local dir
  dir=$(repo "$name" "$allow")
  printf '%s\n' "$text" > "$dir/notes.txt"
  git_ -C "$dir" add notes.txt
  run "$dir" staged; expect "$name: staged" "$want" "$needle"
  printf '%s\n' "$text" > "$dir/.git/TEST_MSG"
  run "$dir" message "$dir/.git/TEST_MSG"; expect "$name: message" "$want" "$needle"
  git_ -C "$dir" commit -q -F "$dir/.git/TEST_MSG"
  run "$dir" all; expect "$name: all" "$want" "$needle"
  run "$dir" history main; expect "$name: history" "$want" "$needle"
}

echo 'No .private-terms-allow: as before the allowlist'
case_ none-subject '' "notes on $SUBJECT" fail 'matches a private term'
case_ none-authorship '' "this was $AUTHORSHIP" fail 'matches a private term'
case_ none-clean '' 'nothing to see' pass

echo
echo 'A subject term allowed'
case_ allow-subject "$SUBJECT" "notes on $SUBJECT" pass
case_ allow-subject-authorship-text "$SUBJECT" "this was $AUTHORSHIP" fail 'matches a private term'

echo
echo 'An authorship pattern listed: never allowed, and the run fails'
case_ allow-authorship "$AUTHORSHIP" "this was $AUTHORSHIP" fail 'authorship patterns are never allowed'
case_ allow-authorship-clean "$AUTHORSHIP" 'nothing to see' fail 'authorship patterns are never allowed'

echo
echo 'An entry that matches no term: reported and ignored'
case_ allow-unknown 'quuxle' 'nothing to see' pass 'matches no subject term'
case_ allow-unknown-subject 'quuxle' "notes on $SUBJECT" fail 'matches a private term'

# The allow file is committable: it is not a private path.
dir=$(repo committable "$SUBJECT")
run "$dir" all; expect 'the committed .private-terms-allow is not refused as a private path' pass

echo
if [[ $failed -eq 0 ]]; then echo 'every hygiene case holds'; else echo 'hygiene cases FAILED'; fi
exit "$failed"
