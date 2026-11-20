# Fixture plan

A test bench for ERLANG's checks: small local services, each with one planted defect, and a clean twin of each with the defect fixed. A check passes when it reports its defect on the planted service and reports nothing on the clean twin. ERLANG publishes its recall and precision on this set, as ITTEN does on its pages.

Built as static pairs, source files that are never installed or run: L07 (`no-timeout`) in `L07-no-timeout/`; L06 (`retry-policy`) in a `libraries/` form (axios-retry 4.5.0, p-retry 9.0.0, got 16.2.0) a `loops/` form (hand-written retries around axios and fetch), and a `layers/` form (retries at several layers, and `retry-budget`); and L01a (`n-plus-one`), L01b (`per-row-writes`), L02 (`unbounded-query`) and L03 (`missing-index`), each in a `sql/` form (Fastify and `pg`) and a `prisma/` form (Express and Prisma 7.10.1); L08 (`pool-exhaustion`) in `L08-pool-exhaustion/` (Fastify and `pg`, a pool of 5); L09 (`blocking-work`) in `L09-blocking-work/` (Express and bcryptjs 3.0.3); L04 (`oversized-payload`) in the `sql/` form its trace form also runs; L05 (`memory-growth`) in `L05-memory-growth/` (Express, `pg` and lru-cache 11.5.3); L10 (`no-cache`) in `L10-no-cache/` (the same stack); L11 (`cold-start`) in `L11-cold-start/` (Express and `pg`); L12 (`no-load-shedding`) in `L12-no-load-shedding/` (Express, Fastify with @fastify/under-pressure 9.2.1, and `node:http`); and L13 (`pool-sizing`), a configuration fixture in a `compose/` form (Docker Compose, PM2, `pg`) and a `kubernetes/` form (a Deployment with an HPA, a worker, a CronJob, Prisma 7.10.1 with `@prisma/adapter-pg`). `scripts/fixture-test.js` scores each pair, and `scripts/fix-test.js` checks its fixes.

Built as trace forms (`scripts/trace.sh`, `research/trace-harness.md`): the `sql/` forms of L01a, L01b and L02, whose twins are run as they are, with a `trace/` folder beside them (the schema, a seed at 1x and 10x, the requests, the expected defects, and a pinned lockfile); L04 (`oversized-payload`), as a `sql/` form with the pages' own data loading in `web/pages.js`, whose twins the static check reads too; L06's `loops/` form, each request failing one upstream host, the attempts it receives counted; L07, a library, through a driver the trace form adds (`trace/overlay/`), each outbound call left unanswered, or the table locked for the pool's query; L08, the connections checked out of the twin's pool counted during its outbound call and after its response; L09, the event loop's longest blocked stretch per request, under the timing lock, from an overlay that fills the twin's in-memory store; and L13's `compose/` form, new connections at the database per request. Added for milestone 8c: L03's `sql/` form, sequential scans read from the plans `auto_explain` logs; L10, reads repeated with the same parameters, from the statement log; L05, heap after a full collection over a soak with a key per request; L11, a fresh process's first request against its later ones, under the timing lock; the `prisma/` forms of L01a, L01b, L02 and L03, their tables made from each twin's own `schema.prisma`; and L13's `kubernetes/` form. L12's trace cell is covered by its load cell (docs/decisions.md, Q3). Each planted twin reports exactly its defects and each clean twin none; every traced defect is linked to the static finding it confirms, except L03's foreign key without an index, a finding on the schema with no endpoint (L03-p3 in the Prisma form), and L04's page views.

The rest is planned. The decisions taken on review are at the end.

## Ground rules

- **Loopback only.** Every fixture binds to `127.0.0.1` and is never deployed, published or exposed. The load driver refuses any target that is not loopback or a CI service container, whatever the flags. Load against another party's service is a denial-of-service attack, so there is no override switch for it in fixture runs.
- **Where load runs.** The full load suite runs in CI or on a separate machine. On the owner's Mac, only a smoke run (one fixture, a few seconds, low rate) runs, and never while ITTEN is timing: ERLANG reads ITTEN's timing lock before and during every load step and refuses or stops while one is active (`research/itten-lock.md`). Static and trace checks at low rate are not load and are not refused.
- **One defect per fixture.** A planted service differs from its clean twin in the defect and nothing else: same routes, same data, same response shape, as far as the defect allows. A diff of the two directories should read as the fix.
- **Seeded data.** Every database is filled by one seeded generator with fixed row counts, so a fixture behaves the same on every run and machine.
- **Outputs go to `dist/`**: reports, traces, load results. Never `/tmp`.
- **Scripts.** Multi-step jobs (start database, seed, start fixture, run, collect, stop) are bash scripts with `#!/usr/bin/env bash` and `set -euo pipefail`.
- **Every suggested fix is tested.** Every finding carries a fix in `erlang.fix` (`lib/fix.js`), of one of two kinds, as in KERCKHOFFS:
  - **auto**: complete edits a program can apply to the source, never to build output. Used when the call's shape is simple: adding a `signal`, a `timeout` or a pool setting to an options object, or adding the options argument.
  - **guided**: no edits; every place the person must change, and a note. Used for fixes that take judgement.

  `scripts/fix-test.js` applies each planted finding's auto fix to a fresh copy of the planted twin and runs the check again. The report must be complete, the finding gone, nothing new reported, and every edited file must still parse. A guided fix is never applied. Instead, the test replaces the lines it lists with the clean twin's lines at the same places, and the finding must then be gone. So the listed places are enough, and the clean twin is the fix a person would write. Then every auto fix is applied together, and only guided findings may be left.
- **One file's failure is that file's.** A file that cannot be read, is not UTF-8, or makes a check throw is recorded as unread. The report is then partial, with the file named and the error described, never quoted (`lib/isolate.js`). The scan goes on, and the CLI exits 3 when there are no findings.
- **The repository scans clean.** `erlang.config.json` at a scan root may exclude paths that are not part of the app (`lib/scope.js`). Every report names the config and what it excludes, and a config that cannot be read refuses the scan. This repository excludes `fixtures/` and `dist/`. `scripts/self-scan.js` runs the CLI on the repository and requires a complete report with no findings, as part of `npm test`.
- **Exit codes**, shared with ITTEN and KERCKHOFFS. Error and warning fail a run; info never does, and the summary counts it apart.
  - 0: complete, with no failing findings.
  - 1: failing findings, whether or not the report is also partial.
  - 2: refused.
  - 3: partial, with no failing findings.
  - 64: bad usage.
- **Expected rows.** A fixture's `defects.json` may list `expected` rows: a finding that is right on both twins, such as an `info` finding ERLANG cannot decide. It must be reported on both twins, as `info`, and counts neither as a catch nor as a false positive. Every clean twin must exit 0. `scripts/fixture-test.js` sets expected findings aside before the shared scorer sees the reports.
- **The timing lock**, shared with ITTEN and KERCKHOFFS (`lib/timing.js`). A timing-based finding counts only when measured at least 3 times with a relative spread of 10% or less, with the 1-minute load average below half the CPU count before and after. Otherwise it is `info`, with the reason `timing unreliable` and the environment recorded, and never fails. Every load finding goes through it.

## What each fixture proves

Each defect can be seen through up to three kinds of evidence. The failure model (`research/failure-model.md`) says which apply to which defect. The fixtures test each channel separately, so a check that relies on one channel cannot hide behind another.

| Channel | Input | Deterministic? |
|---|---|---|
| Static | Source files and migrations | Yes |
| Trace | OpenTelemetry spans and database query logs from a short scripted run at low rate | Mostly: counts are exact, durations are not |
| Load | A local open-model load run (fixed arrival rate, not a fixed number of users), defect against twin | No: judged by ratios between the twins, with repeat runs |

Counts are preferred to timings wherever a defect has a count: queries per request, rows returned, bytes per response, upstream attempts per request, connections checked out. A count is the same on a laptop and on a CI runner. A latency is not. Timing-based judgments compare the planted service with its clean twin, run on the same machine back to back, never against an absolute number.

## Stack

- **Node.js 22 LTS, plain `node:http` or Express, and PostgreSQL 17**, with `pg` as the driver and its built-in pool. Node matches ITTEN's toolchain. PostgreSQL gives a real network connection pool and real query plans (`EXPLAIN`, `pg_stat_statements`), which an embedded database such as SQLite does not. In CI it runs as a service container. Locally it runs in Docker.
- **An upstream stub**: a local HTTP service whose latency, error rate and hang behaviour are set per request by a header or a control endpoint. Fixtures that call another service call this. It counts every attempt it receives, so retry amplification is a count, not a guess.
- **Raw SQL and an ORM.** L01a, L01b, L02 and L03 each come in two forms: raw SQL through `pg`, and Prisma. The static check is entirely different between the two (a SQL string sent inside a loop, against a Prisma `findUnique` called inside a loop over a `findMany` result), while the trace and load checks should not care. There is no Drizzle form: scope is frozen at these two (see Known gaps). The other fixtures use raw SQL, since their defect is not in how the query is written.
- **k6 as the load driver, installed separately.** k6 is AGPL-3.0. ERLANG runs the `k6` program the user or CI installed, as a separate process, and reads its JSON output. It never vendors, bundles, modifies or links k6 code, and its scenarios are generated at run time. ERLANG checks for `k6` on the path and stops with an install hint if it is missing; it does not install it. CI installs k6 from Grafana's release in a workflow step. ERLANG keeps its own guard in front of k6: the target must be loopback or a CI service container, rate and duration are capped, and the ITTEN timing lock is honoured.
- **A second language later.** One Python set (FastAPI with SQLAlchemy) for the static and trace checks, once the Node set passes, to show the checks are not tied to one stack.

## Layout

```
fixtures/
  PLAN.md              this file
  README.md            what each fixture plants, written when they are built
  defects.json         the registry below, read by the fixture test
  seed/                the seeded data generator, one per schema
  upstream/            the upstream stub
  L01a-n-plus-one/
    sql/
      planted/         the service with the defect, raw SQL
      clean/           the twin with the defect fixed
    prisma/
      planted/
      clean/
  L02-unbounded-query/
  ...
  L06-retry-storm/
    planted/           fixtures with one form keep the flat layout
    clean/
```

`defects.json` lists, for each fixture and form: its ID, the form (`sql` or `prisma`), the check expected to fire, the evidence channels expected to see it, the route that shows it, what is planted, and what the twin does instead. The fixture test reads it and fails on any miss, any finding on a twin, and any finding on a planted service other than the one planted. Planted and clean code are written by hand rather than generated from one table, as ITTEN's `make.js` does for its pages: a service's defect lives in control flow, which a table cannot hold.

## Planted defects

IDs follow the ranks in `research/failure-model.md`. Row counts and rates are starting values to tune once the services exist. The rules each fixture exercises are listed in the failure model.

| ID | Check | Planted | In the clean twin | Static | Trace | Load |
|---|---|---|---|---|---|---|
| L01a | `n-plus-one` | `GET /orders` lists 50 orders and fetches each order's customer with its own query: 51 queries. | One query with a join, or two with `WHERE id = ANY($1)`: at most 2. | Query or lazy load inside a loop over a result set | Many database spans of one statement shape under one request span | Statements per request at page sizes 10 and 100 |
| L01b | `per-row-writes` | `POST /orders/import` inserts 1,000 rows with one `INSERT` each. | One multi-row `INSERT` per batch of 500. | Insert or save inside a loop | `INSERT` statements per request | Statements per request at 1× and 10× batch size |
| L02 | `unbounded-query` | `GET /events` returns every row of a 200,000-row table, with no `LIMIT` and no pagination. | Keyset pagination, default page 50, maximum 200, enforced on the server. | List query with no `LIMIT`; page size taken from the client without a cap | Rows returned per statement; response bytes | Response size and latency at 1× and 10× data |
| L03 | `missing-index` | `GET /users/:id/events` filters `events` by `user_id`, which has no index. | Index on `events(user_id, created_at)`. | Query predicates compared with the indexes declared in migrations | `EXPLAIN` of the captured statement shows a sequential scan of a large table | Latency against the twin |
| L04 | `oversized-payload` | `GET /products` returns full rows with a 50 KB description each, uncompressed; the product page needs 20 calls to `GET /products/:id/price`. | The list returns the fields the page uses; responses are compressed; prices come back in one call. | `SELECT *` on list routes; no compression middleware | Response bytes; `Content-Encoding`; calls per page view | Bytes per request; time to load one page view |
| L05 | `memory-growth` | A module-level `Map` caches responses by full query string, with no size limit and no expiry. | An LRU bounded by entries and by age. | Module-level collection that is only ever added to | Process memory against requests served | Resident memory keeps rising over a soak run with unique keys, and does not fall after it |
| L06 | `retry-storm` | Retries a failed upstream call five times at once, with no backoff, no jitter and no budget, including on overload replies (503, 429). | At most 3 attempts, capped exponential backoff with full jitter, no retry on overload replies, and a retry budget. | Retry loop with no delay, or a fixed delay with no jitter | Attempt spans per request and the gaps between them | Attempts the stub counts per user request, with the stub failing |
| L07 | `no-timeout` | Calls the upstream stub with no timeout. The stub is set to accept and never reply. | A timeout on every outbound call, below the route's own deadline, and the deadline passed on. | Outbound HTTP or database call with no timeout set | A span that never ends, or ends only when the client gives up | In-flight requests and open sockets grow for as long as the stub hangs |
| L08 | `pool-exhaustion` | Holds a pooled connection across the upstream call, and does not release it on the error path. Pool size 5. | Takes the connection after the upstream call, releases it in `finally`. | `connect()` with no release in `finally`; a connection held across an `await` on another service | Time waiting for a connection; connections checked out | Errors acquiring a connection once concurrency passes the pool size |
| L09 | `blocking-work` | `POST /signup` hashes the password with `crypto.pbkdf2Sync` at a high iteration count on the request thread. | The asynchronous hash, run on the worker pool. | `*Sync` calls and known CPU-bound calls inside request handlers | Event-loop delay | Latency of `GET /health`, which does no work, while `/signup` is under load |
| L10 | `no-cache` | `GET /stats` runs a 1-second aggregate on every request, for inputs that change once a minute. | Result cached for 60 s with a bound on entries; `Cache-Control` and `ETag` on the response. | Weak: a known-expensive call with no cache in front of it | The same statement with the same parameters on every request | Throughput against the twin |
| L11 | `cold-start` | Builds a large lookup table on the first request, inside the handler. | Builds it at startup, before the service reports ready. | Weak: lazy initialisation inside a handler | A long initialisation span on the first request only | First-request latency after a restart against steady state |
| L12 | `no-load-shedding` | Accepts every request and queues it without limit, so under overload every request is late rather than some refused. | A bounded number of requests in flight; requests over the bound get 503 at once. | Weak: no concurrency limit in front of handlers | Covered by load: queue time rises only with load, which the trace harness does not generate (docs/decisions.md, Q3) | Past the knee the twin keeps goodput flat and refuses the excess quickly; the planted service's goodput falls and its p99 grows without bound (CAP-02) |

| L13 | `pool-sizing` | Pool `max` × every deployed process passes the database's `max_connections` less its reserved connections; a pool made per request. | `max` sized so every process fits at once; one pool per process. | Pool `max` × replicas (or an HPA's `maxReplicas`) × PM2 instances against `max_connections`; a pool or client constructed in a handler | Connections open at the database | Connection errors ("too many clients already") once every process's pool fills |

L01b, L12 and L13 are not in the brief's list. L13 is there because the first check plan (`research/first-check.md`, E) found no prior art for it, and L08's leaked connection is a different defect. L01b is there because row-by-row writes were among the commonest defects in the one controlled study of generated database code. L12 is there because CAP-02, ERLANG's main load oracle, needs a service that fails it.

L01a to L04 can be judged from counts on one machine with no concurrent load, so they are built first: they run on a laptop without breaking the rule about ITTEN's timing runs.

## What must not be reported

As ITTEN's fixtures do, both twins carry things that look like defects and are not. Each guards against a false positive found to be likely while building a check:

- a loop that runs a query once per item over a fixed, small list of known size, such as three settings rows (not an N+1 that grows with data);
- a query with no `LIMIT` that returns one row by primary key (bounded by the key, not unbounded);
- a sequential scan over a 20-row lookup table (the planner is right to scan it);
- a retry with no jitter in a one-off startup migration that no request waits on;
- a module-level `Map` with a fixed set of keys filled at startup (bounded);
- a synchronous file read at startup, outside any handler.

Added while building `n-plus-one` and `per-row-writes` (L01a, L01b):

- `findUnique` once per item, started together in `Promise.all` or a batch `$transaction`, which Prisma 7 sends as one query (`research/prisma-batching.md`);
- a query per page in a `while` loop (keyset pagination: one query per page, not per row);
- `Promise.all` over a fixed array of different queries;
- a helper that queries, called once outside any loop;
- a per-row query or insert in a script no request handler reaches (a backfill, a seed), including a loop to 1,000.

Added while building `unbounded-query` (L02):

- a read by primary key, by a column the Prisma schema marks `@unique`, by a column the SQL migration declares unique or indexes uniquely, or by a list of keys (`in: ids`, `= any($1)`);
- a page size from the client capped with `Math.min`;
- a literal `LIMIT`, a count, a cursor stream, and a table the owner names under `smallTables`.

Added while building `pool-sizing` (L13):

- a pool made on first use and kept (`??=`, a module variable, `globalThis`): one per process, not per request;
- a pool in a script or test helper no deployed process imports (a seed, a test database);
- a CronJob's or a one-off service's pool, which is counted in the total but not reported itself;
- the `globalThis` Prisma singleton.

Added while building `retry-policy` (L06):

- axios-retry with `exponentialDelay`, got's default retry, and p-retry with `randomize`, `maxTimeout` and `AbortError` on 4xx;
- a loop with jittered, capped exponential backoff, a cap on attempts, and no retry on 4xx;
- a polling loop that ends on the job being done, not on a reply succeeding;
- pagination whose `catch` ends the loop, and a `for`-`of` with one call per item;
- a retry, with no jitter, in a migration or script no request waits on.

Added while building `missing-index` (L03):

- a read by primary key or by a unique column;
- a filter whose first column is indexed and whose second is not;
- a filter on a boolean or an enum column, too unselective for an index to help;
- a table the owner names under `smallTables`, and a query in a script no request handler reaches.

Added while building `pool-exhaustion` (L08):

- `pool.query`, which takes and returns its own connection;
- a transaction helper that hands the client to a callback and releases it in `finally`;
- a call to another service made before the connection is taken, and an awaited local function with no I/O while one is held;
- a release chained with `.finally()`, and a release at the end of the `try` and in the `catch`, with no return before it;
- a `pg.Client` of its own, opened and closed with `end()`;
- a script that never releases its connection, which no request runs.

Added while building `blocking-work` (L09):

- `crypto.randomBytes(16)`, synchronous but small, and `crypto.randomUUID()`;
- bcryptjs's asynchronous `hash` and `compare` at cost 4, for one-time codes (docs/decisions.md, Q4: at cost 10 or more bcryptjs is a defect, asynchronous or not), and a SHA-256 of the response with `createHash`;
- a file read when the module loads, and templates read by a function only startup calls;
- synchronous compression in a worker thread;
- bcrypt's `hashSync` in a script no request runs.

Added while building `oversized-payload` (L04):

- `SELECT *` of one row by its primary key, a count, and `SELECT *` in an export script no request runs;
- one call per kind from a fixed list of two, a pagination loop (one call per page), and a page that makes one call.

Added while building `memory-growth` (L05):

- an lru-cache bounded by entries and age, and a Map filled when the module loads and only read;
- a Map written under fixed names, and a Map made per request;
- a Map whose entries a timer deletes, a Set cleared at 1,000, and a WeakMap keyed by the request;
- a list filled by a script no request runs.

Added while building `no-cache` (L10):

- aggregates behind an lru-cache, over one customer's rows, with Cache-Control on the response, behind a POST that recounts on purpose, and in a script no request runs;
- a read per item that uses the item (n-plus-one's, not this check's), the same read before and after a write, and the same read in a polling loop.

L10's planted aggregate is reported as info (whether to cache is a design choice), and the scorer matches it at that severity; the planted twin still exits 1 for its two warnings.

Added while building `cold-start` (L11):

- a value refreshed when it is a minute old (a cache, on purpose), a cheap value made on first use, and a variable of the request set when the body has none;
- a value read with a top-level await when the module loads, one built on first use by a function only startup calls, and one in a script no request runs.

Added while building `no-load-shedding` (L12):

- a Fastify app with @fastify/under-pressure, an Express app with a hand-written limit answering 429, and a `node:http` server with `maxConnections`;
- not a decoy, but a control inside the planted twin: the limiter the clean twin applies is in the planted twin too, unused, so a limiter that exists is not enough.

Added for rank 6's layers and budgets, in L06's `layers/` form (scanned with `retry-policy` and `retry-budget`):

- p-retry around a got POST (got does not retry POST), a retry loop around an axios client with no retries of its own, and p-retry around a call with axios-retry turned off for it, each with a budget;
- a got GET with its default retries and nothing around it, and a retry loop on top of axios-retry in a script no request runs.

L03's SQL fixes add a migration rather than edit one, so its clean twin has a file the planted twin lacks; each such defect names it under `fixedIn` in `defects.json`, and `scripts/fixture-test.js` accepts that difference.

The list grows as checks are built. Each entry names the check it protects.

## Known gaps

What the built checks do not cover, by decision. None of these is planned work; each is recorded so a clean report is not read as covering it.

- **Drizzle.** Scope is frozen at raw SQL through `pg` and Prisma. Drizzle queries are not recognised by any check, so code that uses only Drizzle gets no `n-plus-one`, `per-row-writes` or `unbounded-query` findings.

Known false negatives:

- **Queue-draining `while` loops** (`n-plus-one`, `per-row-writes`). A `while (queue.length) { await query(queue.shift()) }` runs one statement per item, and is missed: `while` loops are not counted as per-item, so that keyset pagination (one query per page, not per row) is not reported.
- **Literal lists of ten or fewer** (`n-plus-one`, `per-row-writes`). A list or loop bound written in the code with at most 10 items is treated as fixed and not reported. This is a precision choice: three settings rows are not an N+1. Ten queries per request from such a list are missed.
- **A list of keys from the client** (`unbounded-query`). `where: { id: { in: ids } }` and `= any($1)` count as bounded by the list, so a list of ids the client sends with no cap is missed.
- **Statements built at run time** (`unbounded-query`). A query whose text comes from a function or a variable ERLANG cannot read is not judged; the run data counts them as unreadable. Prisma options spread from code it cannot read are skipped the same way.
- **Validated page sizes** (`unbounded-query`). A page size that passes through a schema validator (zod, joi) cannot be traced back to request input, so it counts as bounded, whether or not the schema sets a maximum.
- **Deep offsets and eager loading** (`unbounded-query`). `skip`/`OFFSET` from the client, and an `include` of a to-many relation with no `take` (DAT-05), are not checked.
- **One database** (`pool-sizing`). Every pool in a deployment is taken to connect to the same database; pools on different databases are summed together.
- **Processes ERLANG cannot follow** (`pool-sizing`). A service with no `build:` whose image is not the project's, a command that names no project file, or a `node:cluster` fork count leaves that process uncounted or counted at its least (1). A total that passes the limit even so is still reported; otherwise the finding is `info`.
- **Drivers other than `pg` and Prisma** (`pool-sizing`). postgres.js, mysql2 and Knex pools are not counted, so their connections are missing from the total.
- **Surge** (`pool-sizing`). A rolling deploy's extra pods, and kustomize overlays that change replicas, are not read; the auto fix's note says to leave room.
- **Retries of anything but outbound HTTP** (`retry-policy`). A loop retrying a database query or a queue publish is not judged.
- **Other retry libraries** (`retry-policy`). async-retry, cockatiel, ky's `retry` and fetch-retry are not read; got's `calculateDelay` and an axios-retry `retryDelay` function ERLANG cannot read are skipped.
- **Partial jitter** (`retry-policy`). axios-retry's `exponentialDelay` (0 to 20 %), p-retry's `randomize` (×1 to 2) and got's 100 ms noise count as jitter; RTY-04's preference for full jitter is not reported.
- **Uncapped jittered loops** (`retry-policy`). A hand-written loop with jittered exponential backoff and no `Math.min` is not reported: its longest wait cannot be read from the code.
- **Idempotency** (`retry-policy`). RTY-07 (retrying a POST without an idempotency key) is not checked.
- **Layers it does not see** (`retry-policy`). Only layers within one repository: a retry around a call whose client retries (axios-retry on that client, got with its default or explicit retries), around a project function (three calls deep) that retries, or around another retry. A service that retries a call to another service that retries in turn is two repositories and is not seen; nor are retries in a proxy, a service mesh or an SDK other than these. A got instance whose options cannot be read is assumed to keep got's defaults.
- **What counts as a budget** (`retry-budget`, a false negative). Any module-level `let` or `var`, or a module-level value with a method called on it, read where the retry is decided counts as a budget, whatever it does. got's default retries are not judged for a budget, only got calls with a `retry` option.
- **Readiness waits** (`retry-policy`, a false positive). A loop that waits for a server the code itself started has the shape of a retry with a fixed wait. In a project with handlers, it is reported only if a handler reaches it; with none found, it is `info`.
- **Plans and sizes** (`missing-index`). Whether an index pays off depends on the table's size and the column's selectivity; the check reads neither, so it warns, and the trace harness is where a plan decides (DAT-07). Only boolean and enum columns are taken as too unselective.
- **Queries it does not read** (`missing-index`). Filters joined with `OR`, subqueries, CTEs, `UNION`, statements built at run time, `LIKE`, and Prisma relation filters are not judged. A partial index counts as serving every query on its column.
- **Schemas it does not read** (`missing-index`). Only SQL DDL and `schema.prisma`: Knex, TypeORM and Sequelize migrations written in JavaScript are not read, so their tables are unknown and not judged. SQL queries on a Prisma-managed table are not matched against `schema.prisma`, whose names are fields, not columns.
- **Trace forms** (`scripts/trace.sh`). The harness serves Fastify, Express and `node:http` twins, from `src/server.js`, `src/app.js` or the entry `trace.json` names. L06's wait with no jitter (a fixed 1 s) is judged on timings, under the timing lock, so on a busy machine it is inconclusive. L06's `libraries/` and `layers/` forms are not traced: their attempts are the libraries' own, which the static check reads from their pinned source. L07's `search()` is not driven: it imports a package that does not exist (its static finding is info). L09's synchronous read of a small avatar (L09-4) holds the loop for well under a millisecond, so it is confirmed statically only, and bcryptjs's asynchronous hash (L09-5) yields between its 100 ms slices, under the share of the request the loop judge requires, so it is confirmed statically only. L13's over-limit total (c1, k1) sums pools across processes and replicas, which one served process cannot show. A read that grows with the table but streams its response (a cursor) is reported as uncertain: counts cannot tell whether its rows are held in memory at once. Calls per page view are counted only through the page code a fixture provides; nothing renders a page. Timings (L06's wait, L09, L11) need a quiet machine: under ITTEN's benchmarks or other load they come out `timing unreliable` and are skipped, not failed.
- **Checkouts it does not judge** (`pool-exhaustion`). The callback form, `pool.connect((err, client, done) => ...)`, and a checkout not assigned to a variable are counted, not judged. A client that is not released on every path but is passed to a function or returned is taken to be released by the code that receives it, so a leak there is missed.
- **Other pools** (`pool-exhaustion`). Only `pg`'s `Pool` and `pg-pool`, made with `new` or reached through a parameter typed `Pool`. mysql2's `getConnection`, generic-pool, Knex's `acquireConnection` and Prisma's interactive transactions (`$transaction(async (tx) => ...)`, where a slow call holds the transaction's connection) are not read.
- **Other services** (`pool-exhaustion`). A connection held across a call is reported only when the call is fetch, axios, got or `node:http`, made directly or through at most three of the project's own functions. SDK clients (AWS, Stripe), gRPC, Redis and message queues are not recognised, and a call chained with `.then()` rather than awaited is not seen.
- **CPU-heavy code of the project's own** (`blocking-work`). Only the listed calls of `node:fs`, `node:zlib`, `node:crypto`, `node:child_process`, bcrypt and bcryptjs are known. A long loop, `JSON.parse` or `JSON.stringify` of a large body, a regular expression that backtracks, one-shot RSA `crypto.sign`, and other libraries' synchronous calls are not seen; the load harness, measuring event-loop delay, is where they show.
- **Synchronous reads that are cached** (`blocking-work`, a false positive). A helper that reads a file synchronously on its first call and keeps the result is reported, since the check does not read the cache around it.
- **No request handler** (`blocking-work`). Unlike the other checks, it reports nothing then, not `info`: synchronous calls are ordinary in scripts and tools. The run data counts what it passed over.
- **The worker pool** (`blocking-work`). The auto fix moves crypto and zlib work to libuv's pool, 4 threads by default. Under load the wait moves there; the fix's note says to measure it.
- **Whole rows through Prisma** (`oversized-payload`). Only SQL `SELECT *` is read. A Prisma `findMany` with no `select` loads every scalar field too, and is not reported. Whether the caller uses the columns is not read either: a `SELECT *` of a table whose every column the page shows is still reported.
- **Compression elsewhere** (`oversized-payload`, a false positive). Only the `compression` middleware, `@fastify/compress`, and nginx or Caddy files in the repository count. A CDN or load balancer that compresses, configured outside the repository, is unknown, so the app is reported. Compression anywhere in the project counts for every app in it. `node:http` servers and Next.js, which compresses by default, are not judged.
- **Calls per item it cannot see** (`oversized-payload`). Only calls with a URL written as a path (`/items/...`) in a `for`-`of`, `for`-`in`, `map`, `forEach` or `flatMap` over a list. A client with an absolute base URL, a URL built by a helper, and an index loop (`for (let i = 0; ...)`) are missed.
- **Growth it does not see** (`memory-growth`). Only module-level `Map`, `Set`, arrays and object literals, grown with `set`, `add`, `push`, `unshift` or a computed key. Class fields, closures, collections inside other objects, caches grown through a helper that takes the collection as an argument, whole result sets held in memory, and buffers or streams are missed. A removal anywhere counts as a bound, even one that never runs or removes less than is added. With no request handler found, nothing is reported, as with `blocking-work`.
- **Repeated work it does not see** (`no-cache`). Only pg statements and Prisma reads. Repeated outbound calls, repeated computation in JavaScript, reads repeated across functions or across requests, and reads in counter or `while` loops are missed. An aggregate is judged expensive by its shape (count, sum, avg, min, max, GROUP BY with no key in the WHERE), not by its cost; a cache in front of it is any value declared outside the handler that is a `let` or is read with `get`, `has` or `peek`, a cache library, or a Cache-Control or ETag header in the handler, whether or not it really answers for the aggregate.
- **Set-up it does not see** (`cold-start`). Only a variable assigned under a test that it is unset (`!x`, `x === null`, `typeof x === 'undefined'`) or with `??=` or `||=`, with work that takes time: an await, a `*Sync` call, a loop or array iteration, directly or in a project function two calls deep. Lazy getters on classes, caches keyed by request data (one entry built per key), connection pools that open connections on first use (as `pg.Pool` does), and work the platform does on a cold start are missed. A `.map` over a short list counts as work that takes time.
- **Limits it cannot see** (`no-load-shedding`, a false positive). A cap set in a load balancer, platform or proxy configured outside the repository (a cloud load balancer, a Kubernetes ingress, a serverless platform's concurrency limit) is unknown, so the app is reported, and the message says so. A limiter is recognised by its shape: a function applied with `use`, `addHook` or `register` that answers 503 or 429 and compares something. A limiter applied to a router or a Fastify plugin's scope rather than to the app is not seen, and a function that answers 503 after any comparison counts, whatever it compares.
- **Unknown Prisma version** (`n-plus-one`). When neither a lockfile nor `package.json` names `@prisma/client`, batching is assumed, as in Prisma 6 and 7, so `findUnique` calls started together are not reported. Under Prisma 8, which drops the batching, they would be one query each. To revisit when Prisma 8 reaches general availability.

## Acceptance test

- **L09's export under load** (the owner, 20 November 2026; revised the same day after CI run 44725479816, where the planted twin's late share was 0.08 to 0.13): on GET /export's step,
  - the planted twin's late share is at least 0.6 in every pair and at least three times the clean twin's (the bar stays 0.3 and 3x; 0.6 is the fixture's margin);
  - the clean twin's late share is at most 0.05 in every pair of every run (`cleanMax`), and its main thread is busy at most 0.05 of the time at the step's rate on the Mac (`scripts/trace.sh --headroom`).
  The planted twin compresses with gzipSync on the request path; the clean twin compresses in a worker thread that returns one buffer, so its main thread only writes the response. The load form exports 1,000,000 orders (about 100 MB of JSON) 2 a second. History of the Mac target: 0.06 at first, a margin for a runner twice as slow against the 0.2 headroom bar; then 0.08, when zlib.gzip measured 0.065 to 0.078; then 0.05 (the owner, 20 November 2026), when CI run 44745932286 showed a runner three times slower than the Mac (105 ms of main thread an export against 31 to 37, busy 0.217) and the profile put the cost in zlib.gzip handing its output back to the main thread in 16 KiB chunks, whose allocations and garbage collections over a heap holding the orders were most of it. With the worker, a quick measure on a busy Mac gave 10 to 18 ms an export, 0.02 to 0.04 at 2 a second. If a CI target is missed, the numbers are reported before anything else changes.
- **L11's countries** (the owner, 20 November 2026): the seed loads 100,000 countries, not 50,000, in both twins and both forms. At 50,000 the planted first request under load sat at 1.13 times its margin on CI (median 181.4 ms against twice the 80 ms floor, 160; CI run 44770113906), a margin in milliseconds that a faster runner would cross. The target is 1.5 times or more. Back to back on a Mac, the planted first request's median in the trace was 109.9 ms over the baseline at 50,000, 140.5 at 75,000 and 299.3 at 100,000: the cost grows faster than the rows past 75,000. Scaled from CI's 181.4, 75,000 estimates about 232 ms (1.45x, short) and 100,000 between 283 (a straight line through 50,000 and 75,000) and 490 (the measured ratio), 1.8x to 3.1x. At 100,000 the clean route's later requests took 4.3 to 8.9 ms, its headroom 2.59 ms a request (0.013 at 5 a second), and its decoy medians stayed at 0.39 ms (main form) and -2.9 ms (fallback) over the baseline, against half the bar, 10.
- **L09's order count per form** (the owner, 20 November 2026): the overlay seeds `L09_ORDERS` orders, set by each form's `env`. The trace form seeds 200,000 (about 20 MB of JSON): it needs only the planted gzipSync's stretch and its share of the request, and at 1,000,000 the 11.5 MB response took long enough to send that the share fell to 0.83 in one CI sample (run 44745932286), under the 0.85 the planted margin needs. The load form seeds 1,000,000, for the planted twin's late share under load.
- **L11's decoys at a start** (the owner, 20 November 2026): every decoy sample (a route's first-request extra over the baseline, in a twin where it is not a planted defect) is at or under 10 ms, half the 20 ms bar, in the local trace run and in all five CI runs of the release commit. The bar stays at 20 ms. If a sample is over, the numbers are reported and the fixture is not adjusted again.
- **Decoy margin, every timed form** (the owner, 20 November 2026): the fixture suite fails when the median of a decoy's samples in a timed verdict, the heap slope included, is over half the bar it is judged against on every condition, or when any single sample reaches the bar (`scripts/trace/judge.js` and `scripts/load/judge.js`, the DECOY lines). A single sample past half the bar but inside it is printed as an OUTLIER with its diagnostics, not failed (revised the same day: one-off stalls on shared runners; docs/CONTRACT.md, "Margins in the fixture suite").
- **Headroom** (the owner, 20 November 2026): at every judged load step's rate, each clean twin's main thread is busy at most 0.2 of the time (the step's rate times its main-thread time per request, plus its background's), measured by `scripts/trace.sh --headroom` and judged by `scripts/headroom/judge.js`: on the median of ten measurements a step, one a request, with two or more measurements over 0.3 failing outright, and a single one printed as an OUTLIER with its garbage-collection time (revised the same day). Unjudged steps (warm-ups) are printed with their figures and never fail it.
- **Planted margin, every timed form** (the owner, 20 November 2026): the fixture suite fails when the median of a planted defect's samples in a timed verdict, the heap slope included, clears its bar by less than 2x on any condition the bar has, or when any single sample falls below the bar (`scripts/trace/judge.js` and `scripts/load/judge.js`, the PLANTED lines). A single sample short of 2x but clearing the bar is printed as an OUTLIER, not failed (revised the same day). For a time or count bar, twice the value; for a share bounded by 1, the stated equivalent per form (a share that must reach S keeps its margin at 2S when 2S is at most 1, else when its distance from 1 is at most half of (1 - S)). Expected misses are printed and skipped.
- **Priming start, every timed form** (the owner, 20 November 2026): before the judged repeats, the harness starts each twin once, sends the warm-up and one request per judged route, and discards everything from that start; the number of judged repeats is unchanged, and the priming start's numbers are saved in the raw output, marked unjudged.

- Every planted defect is reported by its check, through every channel the registry lists for it. Recall 100%.
- No clean twin has any finding. No planted service has a finding other than its own. Precision 100%.
- Static and trace findings are identical, field by field, across five runs on two machines (a laptop and a CI runner).
- Load findings agree in presence and severity across five CI runs. A load finding that comes and goes is reported as unstable and fails the test, rather than being averaged away.
- Every load run stays under its rate and duration caps, and the run log shows its target was loopback or a CI service container.

## Decisions

Taken on review, 17 November 2026.

1. **Stack.** Node 22 and PostgreSQL first; Python later.
2. **Load driver.** k6, run as an external program installed by the user or CI; never vendored, modified or embedded. The licence boundary is in `research/prior-art.md`.
3. **ORM forms.** L01a, L01b, L02 and L03 in raw SQL and Prisma. Scope frozen on 17 November 2026: no Drizzle form (see Known gaps).
4. **Timing guard.** A lock file written by ITTEN during each serial timing phase, with its pid and an expiry. ERLANG refuses to generate load while one exists and its pid is alive. The spec is `research/itten-lock.md`, for ITTEN to implement.
5. **finding/1.** Released with report/1 at ITTEN's `v0.3.5`. ERLANG uses a pinned copy of KERCKHOFFS's `core/`, which carries both, until the shared core is extracted (`research/first-check.md`). The fixture scorer is the core's `fixture-score.js`.
6. **Static checks first** (`research/first-check.md`). L07 (`no-timeout`) is built first, as a static fixture of source files that are never installed or run. Then L01a and L01b (D), then L02 (C). Prisma is pinned at 7.10.1.
