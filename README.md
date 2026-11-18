# ERLANG: load and resilience checks

Named after A. K. Erlang; not the Erlang programming language.

ERLANG checks how a web service behaves under load and when its dependencies fail: missing timeouts, retry storms, unbounded queries, per-item queries, exhausted pools. It is the load-and-resilience specialist in a set with ITTEN (design) and KERCKHOFFS (security), and writes the same finding format. It tests the owner's own services only.

Status: seven static checks are built, each suggesting a fix for every finding:

- `no-timeout` (TMO-01): outbound calls that nothing bounds in time, from fetch, axios, got, `node:http`/`node:https` and `pg`.
- `n-plus-one` (DAT-01): a query run once per item of a list, in code a request handler reaches, through Prisma or `pg`.
- `per-row-writes` (DAT-02): a write sent once per row the same way, where one statement would do.
- `unbounded-query` (STB-04): a list read with no limit, or with a page size the client chooses with no cap, in code a request handler reaches.
- `pool-sizing` (CAP-08, OVL-11): connection pools that, across every process the deployment files start (Compose, Kubernetes, PM2), can open more connections than the database accepts; and a pool made per request.
- `retry-policy` (RTY-01, RTY-03, RTY-06): retries with no cap on attempts, no backoff or no jitter, or that retry replies that cannot succeed, through axios-retry, p-retry, got or a hand-written loop.
- `missing-index` (DAT-03): columns that queries filter, join or sort on, and foreign keys, with no index starting with them in the SQL migrations or `schema.prisma`; the fix is a new migration or an `@@index`.

Request handlers are found in Express, Fastify, `node:http` and Next.js code. Prisma's batching is taken from what was observed for 7.10.1 (`research/prisma-batching.md`). The checks read source and run nothing. The trace harness (below) runs the fixtures against a database to confirm them by counts; generated load comes later.

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

`npm run trace` (`scripts/trace.sh`) runs the trace harness on the fixtures: each twin is served against PostgreSQL in Docker with seeded data at 1x and 10x, and the statements, rows, calls and bytes of each request are counted and judged (`research/trace-harness.md`). It needs Docker, sends requests one at a time to the fixture on 127.0.0.1, runs at nice 15, and refuses while ITTEN's inspector runs. It is not part of `npm test`.

- `reference/`: the rules ERLANG checks against, with their sources.
- `research/`: the failure model, prior art, the name, and other design notes. `research/first-check.md` explains the order of the checks. `research/probes/` holds runtime probes, such as the Prisma batching probe; it is excluded from the self-scan, since it runs per-item queries on purpose.
- `fixtures/`: the test bench (`fixtures/PLAN.md`). `L07-no-timeout/`, `L01a-n-plus-one/`, `L01b-per-row-writes/`, `L02-unbounded-query/`, `L03-missing-index/`, `L06-retry-storm/` and `L13-pool-sizing/` are built as static pairs; the `sql/` forms of L01a, L01b and L02, and `L04-oversized-payload/`, have trace forms.
- `core/`: a pinned, temporary copy of the shared finding/1 and report/1 code (`core.pin.json`).

## Part of a set

ERLANG is one of three specialists that check their owner's own projects and write one shared finding format (finding/1 and report/1):

- ITTEN: design.
- KERCKHOFFS: security.
- ERLANG: load and resilience.

## Working on it

After cloning, run `scripts/setup.sh` once to enable the commit hooks.

When it is published, the package will be `@atishaypahadiya/erlang` and the command `erlang`.
