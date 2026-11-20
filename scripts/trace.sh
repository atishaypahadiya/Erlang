#!/usr/bin/env bash
# The trace harness (research/trace-harness.md): runs each fixture form's
# twins against PostgreSQL with seeded data at 1x and 10x, counts what every
# request does, and judges the counts. Low-rate requests only, one at a time,
# no load; development and CI only, not part of npm test, since it needs
# Docker and, the first time, the npm registry and Docker Hub.
#
# Usage: scripts/trace.sh [--load] [form ...]   a form is e.g.
#        L01a-n-plus-one/sql; with none, every fixtures/<id>/<form>/trace/
#        trace.json. --load runs the load harness instead (scripts/load.sh,
#        research/load-harness.md) on each form's load/load.json, with k6.
# Outputs: dist/trace/<id>/<form>/<twin>/{raw.json,report.json,twin.log};
#          with --load, dist/load/<id>/<form>/{raw.json,<twin>/report.json}.
# Exit codes: 0 every form as expected; 1 a form was not; 2 cannot run
# (Docker, or Postgres did not start); 64 bad usage; 75 ITTEN's timing lock
# stayed active past the wait (ERLANG_LOCK_WAIT_S, 600 s by default).
#
# Safety, as decided (research/trace-harness.md, Decisions):
# - Everything here runs at nice 15; the container is held to one CPU.
# - Honours ITTEN's timing lock (lib/itten-lock.js): while one is active it
#   waits, rereading about once a second, and stops with 75 at the limit. The
#   lock is reread before each twin starts.
# - PostgreSQL publishes its port on 127.0.0.1 only, never 0.0.0.0, with
#   passwords made for this run and kept in a mode-700 directory under
#   dist/trace/run/; the container and that directory are removed on exit.
#   The superuser is used only through docker exec, never over the port.
# - Each twin listens on 127.0.0.1 only, and requests go only to it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# KERCKHOFFS's pin, per the owner: both projects run the same PostgreSQL.
# A change to it is agreed for both.
IMAGE="postgres:17.11@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f"

current="$(ps -o nice= -p $$ | tr -d ' ')"
if [ "$current" -lt 15 ]; then
  exec nice -n "$((15 - current))" "$0" "$@"
fi

MODE=trace
SPEC=trace/trace.json
LOADFLAG=""
if [ "${1:-}" = "--load" ]; then
  MODE=load
  SPEC=load/load.json
  LOADFLAG=--load
  shift
fi
for a in "$@"; do
  case "$a" in
    -*) echo "usage: scripts/trace.sh [--load] [form ...]   e.g. L01a-n-plus-one/sql" >&2; exit 64 ;;
  esac
  if [ ! -f "fixtures/$a/$SPEC" ]; then
    echo "$MODE: fixtures/$a/$SPEC does not exist" >&2
    exit 64
  fi
done
# Load on a workstation: one form per run (lib/load-guard.js); the full
# suite runs in CI.
if [ "$MODE" = "load" ] && [ "${CI:-}" != "true" ] && [ "$#" -ne 1 ]; then
  echo "load: on a workstation, name exactly one form; the full load suite runs in CI" >&2
  exit 64
fi

# Every wait on ITTEN's lock is logged (phase, taken, expires, how long),
# and recorded one JSON line per wait here.
export ERLANG_LOCK_WAIT_LOG="${ERLANG_LOCK_WAIT_LOG:-$ROOT/dist/logs/itten-lock-waits.jsonl}"
node scripts/itten-lock.js "$MODE" || exit $?
if ! docker info >/dev/null 2>&1; then
  echo "trace: Docker is not running" >&2
  exit 2
fi

if [ "$#" -gt 0 ]; then
  forms=("$@")
else
  forms=()
  while IFS= read -r f; do forms+=("$f"); done < <(cd fixtures && find . -path "*/$SPEC" | sed -e 's|^\./||' -e "s|/$SPEC\$||" | sort)
fi

NAME="erlang-trace-$$"
RUN="$ROOT/dist/trace/run/$$"
umask 077
mkdir -p "$RUN"
chmod 700 "$RUN"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$RUN"
}
trap cleanup EXIT

secret() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }
printf 'POSTGRES_PASSWORD=%s\n' "$(secret)" > "$RUN/pg.env"
secret > "$RUN/app-password"

docker run -d --rm --name "$NAME" --cpus 1 --memory 1g \
  -p 127.0.0.1::5432 --env-file "$RUN/pg.env" \
  "$IMAGE" \
  -c shared_preload_libraries=pg_stat_statements \
  -c pg_stat_statements.track=top \
  -c pg_stat_statements.track_utility=off >/dev/null

ready=0
for _ in $(seq 1 90); do
  # The image initialises with a temporary server, then restarts; only the
  # server after "init process complete" is the one to use.
  if docker logs "$NAME" 2>&1 | grep -q 'PostgreSQL init process complete' \
    && docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null \
    && docker exec "$NAME" psql -U postgres -XAtqc 'select 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "trace: PostgreSQL did not start" >&2
  docker logs "$NAME" >&2 || true
  exit 2
fi

bindings="$(docker port "$NAME" 5432/tcp)"
if [ -z "$bindings" ] || printf '%s\n' "$bindings" | grep -qv '^127\.0\.0\.1:'; then
  echo "trace: the port is bound to something other than 127.0.0.1 ($bindings); stopping" >&2
  exit 2
fi
PORT="$(printf '%s\n' "$bindings" | head -n 1 | cut -d: -f2)"

# The app's role, its password on stdin, never on a command line.
printf "create role erlang_app login password '%s';\n" "$(cat "$RUN/app-password")" \
  | docker exec -i "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U postgres >/dev/null

failed=0
for form in "${forms[@]}"; do
  id="$(printf '%s' "$form" | tr '/' '-')"
  install="$ROOT/dist/trace/install/$id"
  # The twins' package.json, or the form's own when the twins ship none; the
  # load form's lockfile, else the trace form's.
  # A form may run another form's twins (trace.json "twins", e.g. L11's
  # fallback form): their manifest, and their lockfile when it has none.
  twins="fixtures/$form"
  if [ "$MODE" = "trace" ]; then
    rel="$(node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(s.twins ?? "")' "fixtures/$form/$SPEC")"
    [ -n "$rel" ] && twins="$(cd "fixtures/$form/$rel" && pwd)"
  fi
  manifest="$twins/planted/package.json"
  [ -f "fixtures/$form/trace/package.json" ] && manifest="fixtures/$form/trace/package.json"
  [ "$MODE" = "load" ] && [ -f "fixtures/$form/load/package.json" ] && manifest="fixtures/$form/load/package.json"
  lock="fixtures/$form/trace/package-lock.json"
  [ -f "$lock" ] || lock="$twins/trace/package-lock.json"
  [ "$MODE" = "load" ] && [ -f "fixtures/$form/load/package-lock.json" ] && lock="fixtures/$form/load/package-lock.json"
  # A Prisma form: its client is generated into the install from the planted
  # twin's schema (the twins' models are the same; L03's differ only in an
  # index, which the client does not hold), and run.js renders each twin's
  # own schema to SQL with the same CLI.
  prisma_schema="$twins/planted/prisma/schema.prisma"
  [ -f "$prisma_schema" ] || prisma_schema=""
  stamp="$(cat "$manifest" "$lock" ${prisma_schema:+"$prisma_schema"} | shasum -a 256 | cut -d' ' -f1)"
  if [ ! -f "$install/.stamp" ] || [ "$(cat "$install/.stamp")" != "$stamp" ]; then
    rm -rf "$install"
    mkdir -p "$install"
    cp "$manifest" "$install/package.json"
    cp "$lock" "$install/package-lock.json"
    (cd "$install" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)
    if [ -n "$prisma_schema" ]; then
      mkdir -p "$install/prisma"
      cp "$prisma_schema" "$install/prisma/schema.prisma"
      # The schema engine wants a datasource even for a diff from nothing; this
      # one is never connected to.
      printf '%s\n' "import { defineConfig } from 'prisma/config';" \
        "export default defineConfig({ schema: 'prisma/schema.prisma', datasource: { url: 'postgresql://unused@127.0.0.1:1/unused' } });" > "$install/prisma.config.ts"
      (cd "$install" && CHECKPOINT_DISABLE=1 node_modules/.bin/prisma generate > generate.log 2>&1) || { cat "$install/generate.log" >&2; exit 2; }
    fi
    printf '%s\n' "$stamp" > "$install/.stamp"
  fi

  set +e
  ERLANG_TRACE_CONTAINER="$NAME" ERLANG_TRACE_PORT="$PORT" ERLANG_TRACE_IMAGE="$IMAGE" \
    ERLANG_TRACE_APP_PASSWORD_FILE="$RUN/app-password" \
    node scripts/trace/run.js ${LOADFLAG:+"$LOADFLAG"} "fixtures/$form" "dist/$MODE/$form" "$install/node_modules"
  rc=$?
  set -e
  if [ "$rc" = "75" ]; then exit 75; fi
  if [ "$rc" != "0" ]; then
    echo "trace: $form: the run failed (exit $rc)" >&2
    failed=1
    continue
  fi
  # The judge's 3: nothing failed, but a planted defect was only "timing
  # unreliable", so the form is not confirmed (load forms).
  set +e
  node "scripts/$MODE/judge.js" "fixtures/$form" "dist/$MODE/$form"
  jrc=$?
  set -e
  if [ "$jrc" = "3" ]; then unreliable=1; elif [ "$jrc" != "0" ]; then failed=1; fi
done
if [ "$failed" = "1" ]; then exit 1; fi
if [ "${unreliable:-0}" = "1" ]; then exit 3; fi
exit 0
