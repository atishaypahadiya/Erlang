# Erlang

Erlang checks how a web service behaves under load and when its dependencies fail: missing timeouts, retry storms, unbounded queries, per-item queries, exhausted pools, blocking work, memory that only grows, cold starts. It reads a Node.js service's source and reports each defect with the rule it breaks and a suggested fix. Two harnesses confirm the checks on Erlang's own fixtures, one by counting what each request does and one under load. It tests the owner's own services only.

Named after A. K. Erlang, the queueing theorist. It is unrelated to the Erlang programming language.

## Part of a set

| Name | Role | State |
|---|---|---|
| Erlang | Load and resilience: tests the owner's own services, never third-party or production systems without the owner's say-so. | In development |
| [Itten](https://github.com/atishaypahadiya/itten) | Design detail: checks the rendered page up close against a system measured from the owner's inspiration. | v0.3 |
| Kerckhoffs | Security: checks the owner's own code and deployments, never third-party sites. | In development |

Each one stands alone, and all of them write the same formats: findings in finding/1, defined in `schema/finding.schema.json`, inside reports in report/1, defined in `schema/report.schema.json`.

Where two of them conflict, security floors come first, then accessibility floors, then craft.

## What it checks

Fifteen static checks, each suggesting a fix for every finding:

- `no-timeout` (TMO-01): outbound calls that nothing bounds in time, from fetch, axios, got, `node:http`/`node:https` and `pg`.
- `n-plus-one` (DAT-01): a query run once per item of a list, in code a request handler reaches, through Prisma or `pg`.
- `per-row-writes` (DAT-02): a write sent once per row the same way, where one statement would do.
- `unbounded-query` (STB-04): a list read with no limit, or with a page size the client chooses with no cap, in code a request handler reaches.
- `pool-sizing` (CAP-08, OVL-11): connection pools that, across every process the deployment files start (Compose, Kubernetes, PM2), can open more connections than the database accepts; and a pool made per request.
- `retry-policy` (RTY-01, RTY-02, RTY-03, RTY-06): retries with no cap on attempts, no backoff or no jitter, or that retry replies that cannot succeed, through axios-retry, p-retry, got or a hand-written loop; and a retry around a call that already retries, so the attempts multiply.
- `retry-budget` (RTY-05): a retry that nothing across requests limits, such as a token bucket.
- `missing-index` (DAT-03): columns that queries filter, join or sort on, and foreign keys, with no index starting with them in the SQL migrations or `schema.prisma`.
- `pool-exhaustion` (STB-08, STB-09): a connection checked out of a `pg` pool and not released on every path; and a connection held while the code waits on another service.
- `blocking-work` (OVL-12): synchronous calls that hold up the request thread, in code a request handler reaches: `node:fs` and `node:zlib` `*Sync` functions, `crypto.pbkdf2Sync`, `scryptSync`, `child_process` `execSync` and their kind, native bcrypt's `hashSync` and `compareSync`, and bcryptjs at a cost of 10 or more in every form, since it hashes on the request thread either way.
- `oversized-payload` (DAT-04, DAT-08, DAT-09): `SELECT *` in a statement that can return many rows; an app with no compression and no proxy in the repository that compresses; and page code that calls its own service once per item of a list.
- `memory-growth` (STB-05): a module-level `Map`, `Set`, array or object that requests add to and nothing removes from.
- `no-cache` (DAT-06): a read repeated with the same arguments in a loop or in one block with no write between, and (as info) a whole-table aggregate behind a GET with nothing in front of it.
- `cold-start` (STB-10): a value every request depends on, built by the first request that needs it instead of at startup.
- `no-load-shedding` (OVL-02, OVL-03): a server with nothing that caps the requests in flight.

The rules are in `reference/`, with their sources. Request handlers are found in Express, Fastify, `node:http` and Next.js code. The checks read source and run nothing.

The two harnesses are for Erlang's own fixtures, where every defect has a planted twin and a clean twin. The trace harness serves each twin against PostgreSQL and counts the statements, rows, calls and bytes of each request. The load harness drives both twins with k6 at a fixed rate and judges each against the other. Neither ever loads anything but a twin it started on 127.0.0.1.

## How to run it

Node 22 or later.

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
- 70: internal failure; stderr says what failed.

The harnesses use the same codes, and one more: 75, temporarily blocked, when ITTEN's timing lock stayed active past the wait; nothing was judged.

`erlang.config.json` at `<dir>` can exclude paths that are not part of the app, and name entry points Erlang cannot find itself, tables that stay small, the database's `max_connections` when no file in the repository states it, and a warm-up route for the cold-start trace:

```json
{ "exclude": ["fixtures/"], "handlers": [{ "file": "src/worker.js", "function": "handle" }], "smallTables": ["settings"], "database": { "maxConnections": 200 }, "warmup": { "path": "/health" } }
```

On Erlang itself:

- `npm test` runs every test, including a scan of this repository, which must come back clean. Its last stage is a short local load smoke, skipped with a message when k6 or Docker is absent.
- `npm run trace` runs the trace harness on the fixtures. It needs Docker.
- `scripts/trace.sh --headroom` checks that each load form's clean twin has room to spare.
- `npm run load -- <form>` runs the load harness on one fixture form. It needs Docker and k6, which Erlang never installs. The full load suite runs in CI.

The full behaviour, every judge and every bar, is in `docs/CONTRACT.md`. Decisions it cites are in `docs/decisions.md`.

## Known limits

The full list is in `CHANGELOG.md`, under the release's known limits. In short:

- Node.js only. Database access through `pg` and Prisma; Drizzle is not read. Handlers are found in Express, Fastify, `node:http` and Next.js only.
- Static blind spots: statements built at run time, lists from the client, queue-draining loops, partial jitter, other retry libraries and pools, and code Erlang cannot follow (`fixtures/PLAN.md`, Known gaps).
- A memory leak under about 512 bytes a request (trace), or under three times the clean twin's own retention (load), is not detected.
- The trace and load judges measure different quantities with their own bars, so one can find a defect the other misses. The differences are listed form by form in the changelog.
- The harnesses run on Erlang's own fixtures only; on a real project, Erlang's verdicts are static.
- The held-out set has not been planted or scored, so accuracy outside the fixtures is not measured.

## Folders

- `bin/`, `lib/`, `checks/`: the command and the static checks.
- `scripts/`: the tests, the trace and load harnesses, and the release gate.
- `schema/`: the schemas for `erlang.config.json` and Erlang's own finding fields.
- `core/`: a pinned copy of the set's shared finding/1 and report/1 code (`core.pin.json`).
- `reference/`: the rules Erlang checks against, with their sources.
- `research/`: the failure model, prior art, the name, the harness designs and other notes. `research/probes/` holds runtime probes and is excluded from the self-scan.
- `fixtures/`: the test bench, one planted twin and one clean twin per defect class (`fixtures/PLAN.md`).
- `docs/`: the contract and the decisions it cites.

## Working on it

After cloning, run `scripts/setup.sh` once to enable the commit hooks.

When it is published, the package will be `@atishaypahadiya/erlang` and the command `erlang`.

## Licence

Code (`bin/`, `lib/`, `checks/`, `scripts/`, `schema/`, `core/`, `fixtures/` and `research/probes/`) is MIT, in `LICENSE`. The documents are CC BY 4.0, attribution Atishay Pahadiya: `CHANGELOG.md`, this README, and `docs/`, `reference/` and `research/` (apart from `research/probes/`), with a `LICENSE` in each of those folders.
