#!/usr/bin/env bash
# The load harness (research/load-harness.md): each fixture form's twins
# served on 127.0.0.1 against PostgreSQL and driven by k6 at a fixed arrival
# rate, the planted twin judged against the clean one. It shares the trace
# harness's runner (scripts/trace.sh --load), and so its safety: nice 15,
# PostgreSQL on 127.0.0.1 only with passwords made for the run, the container
# removed on exit, ITTEN's timing lock honoured (before each step and every
# 5 s during it). The guard (lib/load-guard.js) loads only the twin the
# harness started on loopback, within caps on rate and duration; on a
# workstation, one form per run. k6 is the one the user or CI installed
# (ERLANG_K6 names another); ERLANG never installs it.
#
# Usage: scripts/load.sh form ...   e.g. scripts/load.sh L12-no-load-shedding
# Exit codes: as scripts/trace.sh; 2 also when k6 is missing or a step is over
# its caps.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/trace.sh" --load "$@"
