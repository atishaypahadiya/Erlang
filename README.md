# ERLANG: load and resilience checks

Named after A. K. Erlang; not the Erlang programming language.

ERLANG checks how a web service behaves under load and when its dependencies fail: missing timeouts, retry storms, unbounded queries, per-item queries, exhausted pools. It is the load-and-resilience specialist in a set with ITTEN (design) and KERCKHOFFS (security), and writes the same finding format. It tests the owner's own services only.

Status: fifteen static checks are built, each suggesting a fix for every finding:

- `no-timeout` (TMO-01): outbound calls that nothing bounds in time, from fetch, axios, got, `node:http`/`node:https` and `pg`.
- `n-plus-one` (DAT-01): a query run once per item of a list, in code a request handler reaches, through Prisma or `pg`.
- `per-row-writes` (DAT-02): a write sent once per row the same way, where one statement would do.
- `unbounded-query` (STB-04): a list read with no limit, or with a page size the client chooses with no cap, in code a request handler reaches.
- `pool-sizing` (CAP-08, OVL-11): connection pools that, across every process the deployment files start (Compose, Kubernetes, PM2), can open more connections than the database accepts; and a pool made per request.
- `retry-policy` (RTY-01, RTY-02, RTY-03, RTY-06): retries with no cap on attempts, no backoff or no jitter, or that retry replies that cannot succeed, through axios-retry, p-retry, got or a hand-written loop; and a retry around a call that already retries (axios-retry on its client, got's default retries for GET, or a project function that retries), so the attempts multiply.
- `retry-budget` (RTY-05): a retry that nothing across requests limits: its give-up test, `retryCondition`, `shouldRetry` or `calculateDelay` reads no state kept across requests, such as a token bucket.
- `missing-index` (DAT-03): columns that queries filter, join or sort on, and foreign keys, with no index starting with them in the SQL migrations or `schema.prisma`; the fix is a new migration or an `@@index`.
- `pool-exhaustion` (STB-08, STB-09): a connection checked out of a `pg` pool with `pool.connect()` and not released on every path, in `finally`; and a connection held while the code waits on another service (fetch, axios, got or `node:http`, directly or through the project's helpers).
- `blocking-work` (OVL-12): synchronous calls that hold up the request thread, in code a request handler reaches: `node:fs` and `node:zlib` `*Sync` functions, `crypto.pbkdf2Sync`, `scryptSync` and their kind, `child_process` `execSync`, `execFileSync` and `spawnSync`, and the native bcrypt package's `hashSync` and `compareSync`; the fix is the asynchronous form, awaited. bcryptjs at a cost of 10 or more is reported in every form, asynchronous included: it is pure JavaScript, so it hashes on the request thread either way. Its fix is guided only: hash off the request thread (`crypto.scrypt`, native bcrypt, or a worker), with a migration path for existing hashes (verify with the old hash, re-hash at the next login).
- `oversized-payload` (DAT-04, DAT-08, DAT-09): `SELECT *` in a statement that can return many rows; an Express or Fastify app with no compression and no proxy in the repository that compresses; and page code that calls its own service once per item of a list.
- `memory-growth` (STB-05): a module-level `Map`, `Set`, array or dictionary object that requests add to and nothing removes from; the fix bounds it.
- `no-cache` (DAT-06): a read inside a loop whose arguments do not change from pass to pass, the same read twice in one block with no write between, and (as info) a whole-table aggregate behind a GET with nothing in front of it that could answer instead.
- `cold-start` (STB-10): a value every request depends on (a table built from a file or the database, a large module, a connection) built by the first request that needs it, `if (!x) x = await build()` or `x ??= …`, instead of at startup.
- `no-load-shedding` (OVL-02, OVL-03): an Express, Fastify or `node:http` server with nothing that caps the requests in flight: no limiter answering 503 or 429 applied to it, no `@fastify/under-pressure`, no `maxConnections`, and no nginx or HAProxy file in the repository that limits connections.

Request handlers are found in Express, Fastify, `node:http` and Next.js code. Prisma's batching is taken from what was observed for 7.10.1 (`research/prisma-batching.md`). The checks read source and run nothing. The trace harness (below) runs the fixtures against a database to confirm them by counts, and the load harness drives them under load.

```
npm install
node bin/erlang.js <dir> [--out <file>]
```

It writes a report/1 to `dist/reports/<dir name>/report.json`, or to `<file>`. Errors and warnings fail a run; info never does. Exit codes:

- 0: complete, with no failing findings.
- 1: failing findings.
- 2: refused.
- 3: partial, with no failing findings.
- 64: bad usage.
- 70: internal failure, a crash (not a refusal and not bad input); stderr says what failed.

The trace and load harnesses use the same codes, and one more: 75, temporarily blocked: ITTEN's timing lock stayed active past the wait, nothing was judged, retry later.

`erlang.config.json` at `<dir>` can exclude paths that are not part of the app, and name entry points ERLANG cannot find itself, tables that stay small, the database's `max_connections` when no file in the repository states it, and a warm-up route for the cold-start trace (a cheap `GET` or `HEAD`, ideally one that reads once through the database driver; without one the harness requests a path that does not exist, which warms the framework only, and says so):

```json
{ "exclude": ["fixtures/"], "handlers": [{ "file": "src/worker.js", "function": "handle" }], "smallTables": ["settings"], "database": { "maxConnections": 200 }, "warmup": { "path": "/health" } }
```

`npm test` runs every test, including a scan of this repository, which must come back clean.

`npm run trace` (`scripts/trace.sh`) runs the trace harness on the fixtures: each twin is served against PostgreSQL in Docker with seeded data at 1x and 10x, and the statements, rows, calls and bytes of each request are counted and judged, with every outbound call going to a stub on 127.0.0.1 that counts it, fails it or never answers it, and the twin's pool counted (`research/trace-harness.md`). It needs Docker, sends requests one at a time to the fixture on 127.0.0.1, runs at nice 15, and waits while ITTEN's timing lock is active (`research/itten-lock.md`). It is not part of `npm test`.

`scripts/trace.sh --headroom` checks each load form's clean twin has room to spare: at every step's rate its main thread is busy at most 0.2 of the time.

`npm run load` (`scripts/load.sh`) runs the load harness on one fixture form: its twins served on 127.0.0.1 against PostgreSQL and driven by k6, which you install yourself, at a fixed arrival rate within capped rates and durations, each twin judged against the other (`research/load-harness.md`): counts and shares as measured, the heap slope per pair, and timed verdicts (latencies, the event loop's longest stretch, the shedding gap) under the relative timing rule, five pairs that all clear, none, or a mix, which is reported as unreliable and never fails (`docs/CONTRACT.md`). It loads only the twins it started on loopback, waits while ITTEN's timing lock is active, and runs the full suite only in CI.

- `reference/`: the rules ERLANG checks against, with their sources.
- `research/`: the failure model, prior art, the name, and other design notes. `research/first-check.md` explains the order of the checks. `research/probes/` holds runtime probes, such as the Prisma batching probe; it is excluded from the self-scan, since it runs per-item queries on purpose.
- `fixtures/`: the test bench (`fixtures/PLAN.md`). `L07-no-timeout/`, `L01a-n-plus-one/`, `L01b-per-row-writes/`, `L02-unbounded-query/`, `L03-missing-index/`, `L06-retry-storm/`, `L08-pool-exhaustion/`, `L09-blocking-work/`, `L05-memory-growth/`, `L10-no-cache/`, `L11-cold-start/`, `L12-no-load-shedding/` and `L13-pool-sizing/` are built as static pairs, and so is the `sql/` form of `L04-oversized-payload/`; every row has a trace form (L01a to L03 in both their `sql/` and `prisma/` forms) except L12, whose queue only load can show, and every row has a load form (`fixtures/PLAN.md`).
- `core/`: a pinned, temporary copy of the shared finding/1 and report/1 code (`core.pin.json`).

## Part of a set

ERLANG is one of three specialists that check their owner's own projects and write one shared finding format (finding/1 and report/1):

- ITTEN: design.
- KERCKHOFFS: security.
- ERLANG: load and resilience.

## Working on it

After cloning, run `scripts/setup.sh` once to enable the commit hooks.

When it is published, the package will be `@atishaypahadiya/erlang` and the command `erlang`.
