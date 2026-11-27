#!/usr/bin/env bash
# The checks on Erlang's pages (README.md, docs/explanation.md and the
# generated docs/reference/), run by npm test and by CI:
#   1. every marked number matches its source (scripts/readme-numbers.js);
#   2. docs/reference/ is what the source gives (scripts/reference.mjs --check);
#   3. every bash block of README.md runs as the page says (blocks.js);
#   4. markdownlint (.markdownlint-cli2.jsonc);
#   5. Vale (.vale.ini, .vale/styles/Erlang), after a control page that each
#      rule must flag, and a check that Files.yml lists the tracked tree's
#      upper-case .md names;
#   6. lychee finds no dead link (lychee.toml);
#   7. each page renders through gh api /markdown, and each mermaid block
#      parses (render.mjs).
# The tools are pinned in scripts/docs/package.json (markdownlint, mermaid,
# jsdom: npm ci --prefix scripts/docs) and in CI's workflow (Vale, lychee).
# Locally a missing tool is skipped with a message; with ERLANG_DOCS_REQUIRED=1,
# as CI sets it, a missing tool fails the run. Lychee and the render need the
# network, and the render needs gh, authenticated.
#
# Usage: scripts/docs/check.sh     exit 0 when every check holds or was skipped
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
PAGES=(README.md docs/explanation.md docs/reference/*.md)
OUT=dist/docs-check
mkdir -p "$OUT"
VALE_CI=3.26.0
LYCHEE_CI=0.24.2
required=${ERLANG_DOCS_REQUIRED:-0}
skipped=()

missing() {
  if [[ $required == 1 ]]; then echo "docs: FAIL  $1 (ERLANG_DOCS_REQUIRED=1)" >&2; exit 1; fi
  echo "docs: SKIPPED  $1"
  skipped+=("$2")
}

node scripts/readme-numbers.js
node scripts/reference.mjs --check
node scripts/docs/blocks.js README.md

TOOLS=scripts/docs/node_modules
if [[ -x $TOOLS/.bin/markdownlint-cli2 ]]; then
  "$TOOLS/.bin/markdownlint-cli2"
else
  missing "markdownlint is not installed (npm ci --prefix scripts/docs)" markdownlint
fi

if command -v vale >/dev/null; then
  v=$(vale --version | awk '{print $3}')
  [[ $v == "$VALE_CI" ]] || echo "docs: note: Vale here is $v, CI's is $VALE_CI."
  tracked=$(git ls-files | grep -E '(^|/)[A-Z][A-Z0-9_-]*\.md$' | xargs -n1 basename | sort -u | tr '\n' ' ')
  listed=$(sed -n '/^exceptions:/,$p' .vale/styles/Erlang/Files.yml | sed -n 's/^  - //p' | sort -u | tr '\n' ' ')
  if [[ $tracked != "$listed" ]]; then
    echo "docs: FAIL  .vale/styles/Erlang/Files.yml lists [$listed], the tracked tree has [$tracked]" >&2; exit 1
  fi
  # The control: one line for each rule, each of which must be flagged. The
  # Attribution line is built here from the rule's own first pattern (the
  # first alternative of each group), so no tracked file holds such a claim.
  mkdir -p "$OUT/vale-control"
  claim=$(node -e '
    const tok = require("fs").readFileSync(".vale/styles/Erlang/Attribution.yml", "utf8").match(/^tokens:\n  - \x27(.+)\x27$/m)[1];
    const s = tok.replace(/\(\?:an\?\\s\+\)\?/g, "").replace(/\(\?:([^|()]+)[^()]*\)/g, "$1").replace(/\\s\+/g, " ").replace(/\\b/g, "");
    if (!new RegExp(tok, "i").test(s)) { console.error("the control claim does not match its rule: " + s); process.exit(1); }
    console.log(s);')
  printf '# Control\n\nThis page was %s.\n\nSee NOTES.md for the rest.\n\nThe ERLANG command reads source.\n\nThis line has no full stop\n' "$claim" > "$OUT/vale-control/control.md"
  control=$(vale --config .vale.ini --output line "$OUT/vale-control/control.md" || true)
  for rule in Attribution Files Name Sentences; do
    grep -q "Erlang\.$rule" <<<"$control" || { echo "docs: FAIL  the Vale control page was not flagged by Erlang.$rule" >&2; exit 1; }
  done
  vale --config .vale.ini "${PAGES[@]}"
  echo "docs: Vale passed on ${#PAGES[@]} page(s); its control page was flagged by all four rules"
else
  missing "Vale is not installed" vale
fi

if command -v lychee >/dev/null; then
  v=$(lychee --version | awk '{print $2}')
  [[ $v == "$LYCHEE_CI" ]] || echo "docs: note: lychee here is $v, CI's is $LYCHEE_CI."
  # lychee reads GITHUB_TOKEN for GitHub links; locally it is taken from gh.
  if [[ -z ${GITHUB_TOKEN:-} ]] && command -v gh >/dev/null; then GITHUB_TOKEN=$(gh auth token 2>/dev/null || true); export GITHUB_TOKEN; fi
  lychee --no-progress --config lychee.toml "${PAGES[@]}"
else
  missing "lychee is not installed" lychee
fi

if [[ -d $TOOLS/mermaid ]] && command -v gh >/dev/null; then
  node scripts/docs/render.mjs "${PAGES[@]}"
else
  missing "the render needs gh and scripts/docs's packages (npm ci --prefix scripts/docs)" render
fi

if (( ${#skipped[@]} )); then echo "docs: passed, with ${skipped[*]} skipped"; else echo "docs: every check passed"; fi
