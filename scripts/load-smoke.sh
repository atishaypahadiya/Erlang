#!/usr/bin/env bash
# The local load smoke: npm test's optional tier. It runs one load form's
# whole path (a fresh database, the priming start, k6 at the step's rate,
# its summary, the raw output) for a few seconds, so load mode is exercised
# before a push. Nothing is judged: it checks only that both twins started,
# took requests and wrote their raw output (dist/load-smoke/<form>/raw.json).
#
# Skipped, with a message and exit 0, when k6 or Docker is absent, or when
# ITTEN's timing lock is active (it does not wait on the lock).
# ERLANG_LOAD_SMOKE_FORM names another load form (default L11-cold-start: 5
# requests a second, its first judged step, 2 seconds a twin).
#
# Exit: 0 passed or skipped; 1 the smoke failed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
FORM="${ERLANG_LOAD_SMOKE_FORM:-L11-cold-start}"
K6="${ERLANG_K6:-k6}"

say() { printf '%s\n' "load smoke: $*"; }

if ! command -v "$K6" > /dev/null 2>&1; then
  say "SKIPPED: k6 is not installed (ERLANG never installs it). Install k6 to exercise load mode before a push; CI's load jobs run it either way."
  exit 0
fi
if ! docker info > /dev/null 2>&1; then
  say "SKIPPED: Docker is not running; the smoke needs the fixture database."
  exit 0
fi

# CI's k6, from the workflow's install step, beside this machine's.
here="$("$K6" version 2> /dev/null | head -1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
ci="$(grep -oE 'Install k6 v[0-9]+\.[0-9]+\.[0-9]+' .github/workflows/ci.yml | head -1 | grep -oE 'v[0-9.]+' || true)"
if [ -n "$ci" ] && [ "$here" != "$ci" ]; then
  say "note: k6 here is ${here:-unknown}, CI's is $ci. The smoke checks that load mode runs, not that the two versions measure alike."
else
  say "k6 ${here:-unknown} (CI: ${ci:-unknown})"
fi

rc=0
ERLANG_LOAD_SMOKE=1 ERLANG_LOCK_WAIT_S=0 ERLANG_K6="$K6" bash scripts/trace.sh --load "$FORM" || rc=$?
if [ "$rc" = "75" ]; then
  say "SKIPPED: ITTEN's timing lock is active; no load is generated while it is."
  exit 0
fi
if [ "$rc" != "0" ]; then
  say "FAIL: $FORM: the run exited $rc"
  exit 1
fi

node --input-type=module - "dist/load-smoke/$FORM/raw.json" "$FORM" <<'EOF'
import { readFileSync } from 'node:fs';
const [file, form] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(file, 'utf8'));
const problems = [];
if (raw.smoke !== true || raw.unjudged !== true) problems.push('raw.json is not marked smoke and unjudged');
const rep = raw.repeats?.[0];
for (const twin of ['planted', 'clean']) {
  const steps = rep?.[twin]?.steps ?? [];
  if (!steps.length) { problems.push(`${twin}: no step ran`); continue; }
  for (const s of steps) {
    const c = s.counts ?? {};
    if (!(c.requests > 0)) problems.push(`${twin} ${s.id}: no requests sent`);
    else if (!(c.ok > 0)) problems.push(`${twin} ${s.id}: no request answered ok (${c.requests} sent)`);
    else console.log(`load smoke: ${twin} ${s.id}: ${c.requests} requests, ${c.ok} ok (not judged)`);
  }
  if (raw.priming && !raw.priming[twin]?.started) problems.push(`${twin}: the priming start did not run`);
}
if (problems.length) { for (const p of problems) console.log(`load smoke: FAIL: ${form}: ${p}`); process.exit(1); }
console.log(`load smoke: PASS: ${form}: load mode ran end to end${raw.priming ? ', priming start included' : ''}; nothing judged`);
EOF
