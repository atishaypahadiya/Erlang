# ERLANG: load and resilience checks

Named after A. K. Erlang; not the Erlang programming language.

ERLANG checks how a web service behaves under load and when its dependencies fail: missing timeouts, retry storms, unbounded queries, per-item queries, exhausted pools. It is the load-and-resilience specialist in a set with ITTEN (design) and KERCKHOFFS (security), and writes the same finding format. It tests the owner's own services only.

Status: five static checks are built, each suggesting a fix for every finding:

- `no-timeout` (TMO-01): outbound calls that nothing bounds in time, from fetch, axios, got, `node:http`/`node:https` and `pg`.
- `n-plus-one` (DAT-01): a query run once per item of a list, in code a request handler reaches, through Prisma or `pg`.
- `per-row-writes` (DAT-02): a write sent once per row the same way, where one statement would do.
- `unbounded-query` (STB-04): a list read with no limit, or with a page size the client chooses with no cap, in code a request handler reaches.
- `pool-sizing` (CAP-08, OVL-11): connection pools that, across every process the deployment files start (Compose, Kubernetes, PM2), can open more connections than the database accepts; and a pool made per request.

Request handlers are found in Express, Fastify, `node:http` and Next.js code. Prisma's batching is taken from what was observed for 7.10.1 (`research/prisma-batching.md`). ERLANG reads source and runs nothing; checks that need traces or generated load come later.

```
npm install
node bin/erlang.js <dir> [--out <file>]
```

It writes a report/1 to `dist/reports/<dir name>/report.json`, or to `<file>`. Exit codes:

- 0: complete, with no findings.
- 1: findings.
- 2: refused.
- 3: partial, with no findings.
- 64: bad usage.

`erlang.config.json` at `<dir>` can exclude paths that are not part of the app, and name entry points ERLANG cannot find itself, tables that stay small, and the database's `max_connections` when no file in the repository states it:

```json
{ "exclude": ["fixtures/"], "handlers": [{ "file": "src/worker.js", "function": "handle" }], "smallTables": ["settings"], "database": { "maxConnections": 200 } }
```

`npm test` runs every test, including a scan of this repository, which must come back clean.

- `reference/`: the rules ERLANG checks against, with their sources.
- `research/`: the failure model, prior art, the name, and other design notes. `research/first-check.md` explains the order of the checks. `research/probes/` holds runtime probes, such as the Prisma batching probe; it is excluded from the self-scan, since it runs per-item queries on purpose.
- `fixtures/`: the test bench (`fixtures/PLAN.md`). `L07-no-timeout/`, `L01a-n-plus-one/`, `L01b-per-row-writes/`, `L02-unbounded-query/` and `L13-pool-sizing/` are built.
- `core/`: a pinned, temporary copy of the shared finding/1 and report/1 code (`core.pin.json`).

## Part of a set

ERLANG is one of three specialists that check their owner's own projects and write one shared finding format (finding/1 and report/1):

- ITTEN: design.
- KERCKHOFFS: security.
- ERLANG: load and resilience.

## Working on it

After cloning, run `scripts/setup.sh` once to enable the commit hooks.

When it is published, the package will be `@atishaypahadiya/erlang` and the command `erlang`.
