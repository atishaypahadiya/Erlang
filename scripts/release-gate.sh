#!/usr/bin/env bash
# The release gate (docs/CONTRACT.md, "Release gate"): a commit may be tagged
# only when
#   1. its last five completed CI runs (workflow ci, any event but the tag's
#      own run) are all green, with no red run among them; and
#   2. the trace reports those five runs uploaded (artifact trace-reports) are
#      identical apart from what a machine measures (scripts/compare-reports.js),
#      and so is a local trace run, when one is given (--local <dir>); and
#   3. their rows hold (scripts/compare-reports.js, the owner, 20 November
#      2026): every planted row's finding is present, as an error or a
#      warning, in every run, and never reads "timing unreliable"; no row with
#      nothing planted is an error or a warning in any run. An info "timing
#      unreliable" on a row with nothing planted is not a difference: it is
#      counted and printed with its row and run, and the gate fails if one row
#      has one in two or more runs, or one run has more than two; and
#   4. the fit of every planted row judged on a fitted slope holds across
#      the runs (scripts/fit-margin.js): median R² at least half way from the
#      judge's bar to 1, no run under the bar.
# Run before tagging, and again by CI on the tag itself (job release-gate).
#
# Usage: scripts/release-gate.sh <commit> [--local <dir>] [--exclude-run <id>]
# Needs gh, authenticated (GH_TOKEN in CI). Writes to dist/release-gate/.
# Exit codes: 0 the gate holds, 1 it does not, 64 bad usage, 70 internal failure.
set -euo pipefail
trap 'echo "release-gate: internal failure at line $LINENO (exit 70)" >&2; exit 70' ERR
cd "$(dirname "${BASH_SOURCE[0]}")/.."

RUNS=5
sha="${1:-}"
[ -n "$sha" ] || { echo "usage: scripts/release-gate.sh <commit> [--local <dir>] [--exclude-run <id>]" >&2; exit 64; }
shift
local_dir=""
exclude=""
while [ $# -gt 0 ]; do
  case "$1" in
    --local) local_dir="${2:-}"; shift 2 ;;
    --exclude-run) exclude="${2:-}"; shift 2 ;;
    *) echo "usage: scripts/release-gate.sh <commit> [--local <dir>] [--exclude-run <id>]" >&2; exit 64 ;;
  esac
done
sha="$(git rev-parse "$sha^{commit}")"
out="dist/release-gate/${sha:0:12}"
rm -rf "$out"
mkdir -p "$out"

# The commit's CI runs, oldest first; the last five completed ones decide.
gh run list --workflow ci.yml --commit "$sha" --limit 100 \
  --json databaseId,status,conclusion,event,createdAt > "$out/runs.json"
# (No mapfile: macOS ships bash 3.2.)
last=()
while IFS= read -r line; do last+=("$line"); done < <(node -e '
  const [file, exclude, n] = process.argv.slice(1);
  const runs = JSON.parse(require("fs").readFileSync(file, "utf8"))
    .filter((r) => r.status === "completed" && String(r.databaseId) !== exclude)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const r of runs.slice(-Number(n))) console.log(`${r.databaseId} ${r.conclusion} ${r.event} ${r.createdAt}`);
' "$out/runs.json" "$exclude" "$RUNS")

held=1
echo "release-gate: commit $sha, its last $RUNS completed CI runs:"
for line in ${last[@]+"${last[@]}"}; do echo "  $line"; done
if [ "${#last[@]}" -lt "$RUNS" ]; then
  echo "release-gate: only ${#last[@]} completed run(s), $RUNS needed" >&2
  held=0
fi
dirs=()
for line in ${last[@]+"${last[@]}"}; do
  read -r id conclusion _ <<< "$line"
  if [ "$conclusion" != "success" ]; then
    echo "release-gate: run $id is $conclusion, not green" >&2
    held=0
    continue
  fi
  if ! gh run download "$id" --name trace-reports --dir "$out/$id" > /dev/null 2>&1; then
    echo "release-gate: run $id has no trace-reports artifact" >&2
    held=0
    continue
  fi
  dirs+=("$out/$id")
done
if [ -n "$local_dir" ]; then dirs+=("$local_dir"); fi

if [ "$held" = "1" ]; then
  rc=0
  node scripts/compare-reports.js "${dirs[@]}" || rc=$?
  if [ "$rc" = "70" ]; then exit 70; fi
  if [ "$rc" != "0" ]; then held=0; fi
  # 4. The fits of planted slope rows across the runs (scripts/fit-margin.js).
  frc=0
  node scripts/fit-margin.js reports "${dirs[@]}" || frc=$?
  if [ "$frc" = "70" ]; then exit 70; fi
  if [ "$frc" != "0" ]; then held=0; fi
fi

if [ "$held" = "1" ]; then
  echo "release-gate: holds for $sha"
  exit 0
fi
echo "release-gate: does not hold for $sha" >&2
exit 1
