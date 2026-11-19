# Trace harness for L01 to L04: a proposal

Status: proposal, 17 November 2026, with the owner's decisions at the end. Built for decision 6's scope: `scripts/trace.sh`, with the trace forms of L01a, L01b, L02 and L04. Where the build changed the proposal, the change and its reason are written in place.

The static checks read code and schema. They cannot see how many statements a request really sends, how many rows come back, or which plan the database picks. The trace harness runs each fixture twin against a real PostgreSQL with seeded data. It sends a few requests one at a time and measures each at two data sizes, 1× and 10×. A defect that grows with data shows up as a ratio. This is DAT-07, "judge data access at production scale", and it is the Trace column of `fixtures/PLAN.md` for L01 to L04.

It generates no load. Requests are serial, at most a few per second, a few dozen per fixture.

## What it measures, per fixture

| Fixture | Measured per request, at 1× and 10× | Judgement |
|---|---|---|
| L01a `n-plus-one`, L01b `per-row-writes` | Statements the request sends (`pg_stat_statements` calls), and the items it handles | Per-item slope k = (C₁₀ − C₁) / (n₁₀ − n₁). k ≥ 0.5 means statements grow with items: a defect. C₁₀ / C₁ ≤ 1.2 means a fixed count: clean. Anything between is reported as uncertain, never as either. |
| L02 `unbounded-query` | Rows the statement returns (`pg_stat_statements` rows), rows and bytes in the response | R = rows₁₀ / rows₁. R ≥ 5 means the read grows with the table. R ≈ 1 means it is bounded by a page or a key. |
| L03 `missing-index` | The plan of each statement the request sends (`auto_explain`, JSON) | Judged at 10× only, since at 1× a sequential scan can be the right plan (DAT-03). A `Seq Scan` on a table of 10,000 rows or more, with a filter that removes most of them, is a defect. The clean twin must show an index scan for the same statement. |
| L04 `oversized-payload` | Response bytes with and without `Accept-Encoding: gzip`, `Content-Encoding`, calls per page view (the fixture's documented page sequence) | Not a scale ratio. Compared against the clean twin and thresholds in PLAN. |

Each route is requested three times per size: one warm-up, then two measured. If the two measured counts differ, the result is "unstable" and reported as such, not averaged. The planted twin must fail and the clean twin pass, the same acceptance rule the static fixtures use.

Findings follow finding/1 with `detection: ["trace"]`, written to `dist/trace/<fixture>/<form>/<twin>/report.json` beside the raw counts and plans.

## Counting statements: `pg_stat_statements`, not the driver's log

**Recommended: count at the database.** `pg_stat_statements` and `auto_explain` both ship with the official image, so nothing is installed. The server starts with:

```
-c shared_preload_libraries=pg_stat_statements
-c pg_stat_statements.track=top -c pg_stat_statements.track_utility=off
```

`auto_explain` joins them when L03's plans are read (decision 6).

How a request is attributed:
- Requests are sent one at a time, so everything between a reset and a read belongs to one request.
- The harness calls `pg_stat_statements_reset()`, sends the request, waits for the response, then reads `sum(calls)` and `sum(rows)`.
- Only statements from the app's role are counted. The fixture connects as `erlang_app` and the harness as `postgres`, so the harness's own reads stay out of the count.
- `track_utility=off` leaves out `BEGIN`, `COMMIT` and `SET`, as the Prisma probe did.
- Only top-level statements count (`track=top`, and `toplevel` when reading). This proposal first said `track=all`. The first run showed why that is wrong: PostgreSQL checks each foreign key of each inserted row with a statement of its own (`SELECT 1 FROM ONLY ... FOR KEY SHARE`). With `track=all` those were counted as statements the request sent, and L01b's clean twin, whose single batched insert sends one statement for 100 rows, read as 101 statements.

Why the database and not the driver:
- **It covers every client the same way.** Raw `pg`, Prisma, Knex, TypeORM and Drizzle are all counted, with no reader per client.
- **It covers what the static reader does not.** The static checks read only `pg` and Prisma, and Drizzle is a known gap (`fixtures/PLAN.md`, Known gaps). At the database, a Drizzle N+1 is one more growing count. So trace-based N+1 detection covers Drizzle and every other ORM without a new reader.
- **It counts what reached the server.** Prisma's batching (`research/prisma-batching.md`) and any client-side merging are already applied.
- **The trade-off is the source line.** A trace finding names the route and the repeated statement (`pg_stat_statements`' normalised text), not the line that sent it. When a static finding agrees, the two are linked (decision 4), so the report carries both the count and the line. For ORMs the static checks do not read, the trace finding is the only one.

**The alternative, the driver's log**, was used in the Prisma probe through its `query` events, and it matched the database counts there. The cost is a hook per client. `pg` has no query event without patching the client or adding OpenTelemetry instrumentation. Keep it as a cross-check for Prisma only.

## Seeded data

- **Generated inside Postgres:** `generate_series` with `setseed()`, from `fixtures/<id>/<form>/seed.sql`, parameterised by `:scale` (1 or 10) through `psql -v`. Data is never shipped from the host, generation is deterministic for a given seed, and each fixture's schema is its own migration (`pg` forms) or `prisma db push` (Prisma forms).
- **What grows:** the items a route handles, not only the table. For L01, a customer's orders go from 10 at 1× to 100 at 10×, so an N+1 shows as 11 statements against 101. For L02 and L03, the table goes from 10,000 to 100,000 rows, with the route's own filter selecting a fixed slice.
- **The seed is recorded** in the run data with the scale, row counts per table and the seed file's SHA-256.

## Postgres in Docker

**The image is the one KERCKHOFFS pins, so both projects run the same PostgreSQL:**

```
postgres:17.11@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f
```

Provenance:
- The digest is recorded in KERCKHOFFS's `research/`. ERLANG takes it from the owner, not by reading that repository. A change to it is agreed by the owner for both projects.
- It was checked against Docker Hub on 17 November 2026: the digest resolves to an OCI image index, and the `17.11` tag still points to it.
- ERLANG writes it in its harness script, with a comment saying it is KERCKHOFFS's pin.

**The connection.** KERCKHOFFS runs this image with `--network none` and reaches it only through `docker exec`. ERLANG's fixture service needs a database connection, so it needs one of two things, and never a port on `0.0.0.0`:
- **A port on `127.0.0.1` only** (`-p 127.0.0.1::5432`). Docker picks the host port, and the script reads it back with `docker port`. The fixture service and the harness run on the host as they are.
- **A private Docker network** (`docker network create --internal`, no route out), with the fixture service in a second container on it, and requests sent through `docker exec`. No port reaches the host at all, but every fixture's dependencies must install inside a Node image.

Decided: the loopback port (decision 2).

How it runs:
- `docker run --rm` with a name per run, removed on exit, including on failure (a trap).
- A random password per run, written to `dist/trace/run/` with mode 600. Not trust auth: unlike KERCKHOFFS's `--network none` container, this one has a reachable port, even if only on loopback.
- `--cpus 1 --memory 1g`.

## Running beside other work

- **The harness is a bash script** (`#!/usr/bin/env bash`, `set -euo pipefail`), with every output in `dist/trace/`.
- **Host processes run at `nice -n 15`:** the fixture service, the request driver and `psql`. On macOS, `nice` does not reach inside Docker Desktop's VM, so the container is bounded by `--cpus 1` instead. Seeding at 10× is the heaviest step: a few seconds of inserts inside the container.
- **Requests are serial:** at most 5 per second, a few dozen per fixture, no concurrency, nothing aimed at anything but the fixture on `127.0.0.1`.
- **ITTEN timing runs:** the harness generates no load, but the project rule keeps heavy work off this Mac while ITTEN timing runs. ITTEN has no lock file for its timed phases yet. The harness refuses to start while ITTEN's inspector process is running (decision 1). This is temporary: it changes to ITTEN's lock file once ITTEN 0.5 writes one.
- **Fixture installs:** the fixtures are never installed today. The harness installs each form from a committed `package-lock.json` into `dist/trace/install/<form>/`, as `research/probes/prisma7-batching/run.sh` does, with `--ignore-scripts` and an explicit `prisma generate`. Making the lockfiles needs the npm registry once. After that, installs are pinned.

## Beyond counting statements

Added for L06, L07 and L08 (19 November 2026). Requests stay serial; nothing here is load.

- **A stub for every outbound call.** `scripts/trace/serve.js` patches `node:http`, `node:https` and `fetch` before it imports the twin, so every call the twin makes (axios, got and the rest are built on these) reaches a stub that `scripts/trace/run.js` runs on 127.0.0.1. A request's `upstream` says how the stub answers while it runs: a status and body, after a delay, never (`hang`), or per host. The stub records each call it receives, with its time.
- **Probes over IPC.** The served twin answers the harness's questions on its IPC channel: its pool's counts (`total`, `idle`, `waiting`, from the pool `src/db.js` exports), its heap after a full collection (node runs with `--expose-gc`), and the event loop's delay over a request.
- **New judges.** `attempts` (L06): calls one failing host received for one request, the gaps between them, and whether the twin was still retrying when the harness gave up. `pool` (L08): connections checked out while the stub answered the outbound call (STB-09), and after the response against before the request (STB-08); a request that leaks runs on a twin of its own (`restart`). `hang` (L07): whether any response came within a limit longer than every deadline the clean twin sets.
- **A driver for a library.** L07's twins are a library with no server. Its trace form adds `trace/overlay/trace-driver.js`, one route per function, copied over the twin's copy; the twins are unchanged. A static finding with no endpoint is linked by the symbol the request drives.

## What it does not do

- **No load and no concurrency.** Load shedding (L12) and every capacity rule stay with a separate load harness. Pool exhaustion (L08) is traced one request at a time, from the pool's own counts, not by exhausting it.
- **No production data, and no service but the fixture.** Outbound calls go to the stub, never to the hosts the twin names.
- **No timing judgement outside the timing lock.** Counts are deterministic on seeded data; latency on a shared laptop is not. A judgement on a time (the fixed wait between retries in L06) counts only under the shared timing lock (`lib/timing.js`); otherwise it is info with reason `timing unreliable`, and the harness's self-check reports the planted defect as inconclusive, not missed (docs/decisions.md, Q2).

## Decisions

Taken on review, 17 November 2026.

1. **ITTEN timing runs.** The harness refuses to start while ITTEN's inspector process is running. Temporary, until ITTEN writes its lock file (0.5); then the harness reads the lock file instead.
2. **Connection.** A port on `127.0.0.1` only, a random password per run, the container removed after the run. Image `postgres:17.11@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f`, KERCKHOFFS's pin. Never `0.0.0.0`.
3. **Where it runs.** Locally, at `nice -n 15`, with the container at `--cpus 1`.
4. **Counting.** `pg_stat_statements` is reset before each request, and requests are strictly sequential.
   - When a trace finding and a static finding agree on the route and the statement's shape, the report links them. The report then carries the count evidence from the trace and the source line from the static check.
   - Prisma's query log stays a cross-check only.
5. **Thresholds.** k ≥ 0.5 and C₁₀/C₁ ≤ 1.2 (L01), R ≥ 5 (L02), 10,000 rows (L03). Recorded as starting values, to tune on the planted and clean twins before any trace precision is published.
6. **First scope.** The trace forms of L01a, L01b, L02 and L04, count-based only. L03's plan reading (`auto_explain`) comes later.

Not pursued: the private Docker network. It was proposed for the connection, and the loopback port was chosen instead.
