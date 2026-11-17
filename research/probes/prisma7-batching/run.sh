#!/usr/bin/env bash
# Runs the Prisma 7.10.1 batching probe (probe.mjs) with both of Prisma 7's
# generators, on the Node that runs this script and on Node 22, the stack's
# baseline. Each Node gets its own copy under dist/probes/prisma7-batching/,
# installed from package-lock.json with that Node (better-sqlite3 is a native
# module, built per Node version), and its own SQLite files there. Nothing is
# installed or written in the source tree. No load: ten rows and a handful of
# statements per case, counted from Prisma's query log.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
out="$root/dist/probes/prisma7-batching"
rm -rf "$out"
mkdir -p "$out"

# probe <label> <command prefix that runs a program under the chosen Node>
probe() {
  local label=$1; shift
  local work="$out/$label"
  mkdir -p "$work"
  cp -R "$here/package.json" "$here/package-lock.json" "$here/prisma" "$here/probe.mjs" "$work/"
  (
    cd "$work"
    "$@" npm ci --no-audit --no-fund > install.log 2>&1
    "$@" npx prisma generate > generate.log 2>&1
    for gen in js ts; do
      "$@" node --experimental-strip-types --no-warnings probe.mjs "$out/result-$gen-$label.json" "$gen"
    done
  )
}

probe "node$(node -p 'process.versions.node.split(".")[0]')" env
# Node 22 from npm's "node" package, put first on PATH for its copy.
if node22=$(npx -y -p node@22 -c 'dirname "$(command -v node)"' 2> /dev/null) && [[ $(PATH="$node22:$PATH" node -p 'process.versions.node.split(".")[0]') == 22 ]]; then
  probe node22 env PATH="$node22:$PATH"
else
  echo "probe: Node 22 could not be fetched; only $(node --version) was probed" >&2
fi
