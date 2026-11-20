# Changelog

## 0.1.0

The first release. Built and fixture-tested: every planted defect in ERLANG's own fixtures (L01a to L13) is found, and no clean twin reports anything (recall and precision 1.00), statically, by trace and under load, on five consecutive CI runs whose trace reports agree. Nothing is claimed for code outside the fixtures; the held-out set has not been planted or scored. finding/1 and report/1 come from a pinned copy of the shared core, to be re-pinned when it gains expected rows.

### Static checks (`erlang <dir>`)

These read source and configuration only. They run nothing and open no socket. Every finding is finding/1 inside report/1, and each comes with a suggested fix: automatic where it is safe, guided where it is not.

- `no-timeout` (TMO-01): outbound calls with no time limit, through fetch, axios, got, `node:http`/`https` and `pg`.
- `n-plus-one` (DAT-01) and `per-row-writes` (DAT-02): one query or write per item of a list, through `pg` and Prisma. Prisma's batching follows what was observed for 7.10.1.
- `unbounded-query` (STB-04): list reads with no limit, or with a page size the client chooses and nothing caps.
- `pool-sizing` (CAP-08, OVL-11): pools across every process that Compose, Kubernetes or PM2 starts, against the database's connection limit; a pool made per request.
- `retry-policy` (RTY-01, -02, -03, -06) and `retry-budget` (RTY-05):
  - retries with no cap, no backoff or no jitter;
  - retries of replies that cannot succeed;
  - retries stacked at several layers;
  - retries with no limit across requests.
- `missing-index` (DAT-03): filtered, joined and sorted columns, and foreign keys, with no index, read from SQL migrations and `schema.prisma`.
- `pool-exhaustion` (STB-08, -09): a connection not released on every path, or held across a call to another service.
- `blocking-work` (OVL-12): synchronous calls on the request thread. bcryptjs at cost 10 or more is reported in every form, with a guided fix.
- `oversized-payload` (DAT-04, -08, -09): `SELECT *` on many rows, no compression, and page code calling its own service once per item.
- `memory-growth` (STB-05): module-level collections that requests add to and nothing removes from.
- `no-cache` (DAT-06): a read repeated with the same arguments, and an unfronted whole-table aggregate (as info).
- `cold-start` (STB-10): set-up a request does on first use instead of at startup.
- `no-load-shedding` (OVL-02, -03): a server with nothing capping the requests in flight.

Request handlers are found in Express, Fastify, `node:http` and Next.js.

`erlang.config.json` can set:

- `exclude`;
- `handlers`;
- `smallTables`;
- `database.maxConnections`;
- `warmup`: a GET or HEAD path for the cold-start trace.

### Trace harness (`npm run trace`)

- Each fixture's twins are served against PostgreSQL in Docker, seeded at 1x and 10x, one request at a time on 127.0.0.1, at nice 15.
- Findings come from counts: statements, rows, calls, bytes and connections per request; query plans; attempts at an upstream stub that fails or never answers.
- **Memory (L05):** heap slopes over soaks, judged on each twin alone. A leak needs at least 512 bytes a request with a fit of R² 0.9 or better.
- **Cold start (L11):** first-request cost in fresh processes, after a warm-up. The warm-up is the configured route, or else a 404 to a path that does not exist. The report says which ran and that the 404 warms the framework but not the database driver.
- **Event-loop stretches (L09):** judged under the relative timing rule.

### Load harness (`npm run load`)

- k6, which you install yourself, at a fixed arrival rate. It targets only twins the harness started on loopback, with rates and durations capped per step and per run (workstation, CI, and CI long). The full suite runs in CI.
- **Judging:** each twin against the other, never against an absolute number.
  - Counts and shares are judged as measured: statements, rows read, shared blocks, attempts, connections, bytes, failed requests.
  - The heap slope is judged per pair.
  - Timed verdicts (latencies, the event loop's longest stretch, late shares, the shedding gap) are judged under the relative timing rule.
- **Headroom:** `scripts/trace.sh --headroom` measures each load form's clean twin, one request at a time: at every step's rate, its main thread must be busy at most 0.2 of the time, or a verdict that compares the twins under load would turn on the machine's speed. CI checks every form.
- **Postgres** is pinned by digest, with a random password per run, and the container is removed afterwards.

### Timing rules

- **Count-based verdicts** never depend on the machine's load.
- **The relative timing rule (c):** for a verdict comparing two conditions measured together. Five repeats; a finding when every repeat clears the threshold, none when no repeat does, and unreliable (info, never failing) for a mix. Pairs alternate twin order. Spread and load average are recorded but gate nothing.
- **Absolute waits** (L06's fixed wait between retries): judged on the delay the code declares, recorded from the twin's timers (the global `setTimeout`, `node:timers`, and `node:timers/promises`' `setTimeout` and `scheduler.wait`), not on a clock; no load average or spread gates it. Retries spaced apart with no timer seen are info, "wait not observed", never clean.
- **Decoy margin:** in a timed form, every decoy stays at most half way to its bar on at least one of the bar's conditions; the judges print it on `DECOY` lines and fail the form when it is not.
- **ITTEN's timing lock:** the harnesses generate no load while it is active. They wait and log every wait (phase, taken, expires, duration). A lock in an unknown format counts as active.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Complete, no failing findings |
| 1 | Failing findings (error or warning) |
| 2 | Refused (unreadable directory or config; for the load harness, k6 missing or over its caps) |
| 3 | Partial with no failing findings; for the harnesses, also a planted defect judged only "timing unreliable" (UNRELIABLE, never a pass) |
| 64 | Bad usage |
| 70 | Internal failure: a crash, not a refusal and not bad input, including a module that fails to load. Stderr says `internal failure` and what failed. (Until now a crash exited 1, which read as failing findings.) |
| 75 | Harnesses only: ITTEN's lock stayed active, nothing was judged, retry later. `erlang <dir>` never returns it. |

Error and warning fail a run; info never does.

### Release gate

A `v*` tag is cut only when its commit's last five CI runs are green and their trace reports are identical apart from what each finding lists as measured, as is a local run on a second machine (`docs/CONTRACT.md`, "Release gate"; `scripts/release-gate.sh`). CI checks the gate again on the tag.

### Findings

A trace or load finding carries the values its message quotes: `erlang.values.measured` (what the run measured), `erlang.values.declared` (what the code, the fixture or the judge declares) and `erlang.template` (the message with each value as `{name}`). finding/1's `measured` lists the measured paths, so runs are compared by template and declared values without knowing any check. Proposed for the shared format (`docs/CONTRACT.md`).

### Known limits

- **Detection floor (L05).** A leak under about 512 bytes a request (trace), or under three times the clean twin's own retention per pair (load), is not detected. L05's `POST /orders`, about 83 to 215 bytes an order, is kept as a documented expected miss. It is reported on an EXPECTED line, not deleted.
- **Thin margins,** all on ERLANG's own fixtures (none crossed on the last two CI runs):

  | Form | Quantity | Observed | Bar |
  |---|---|---|---|
  | L05 trace | placeCart's fit | R² 0.95 to 0.96 | 0.9 |
  | L05 load | createOrder's closest pair | 193 B/request | 203 |
  | L09 load | clean twin's signup stretch | ≤ 34 ms | 50 |
  | L11 load | decoy price | ≤ 53 ms | 80 |
  | L11 trace, warm-up form | decoy above the baseline | 4 to 7 ms | 20 |
  | L11 trace, fallback form | clean twin's largest extra | 12 ms | 25 |

- **Routes that commit on L11:** a route whose first request writes to the database can read "timing unreliable" in the cold-start trace, because each commit waits on the disk's flush and that wait varies by several milliseconds. The remedy for a trace database is `synchronous_commit = off`, set on the database (trace.json `database`), not in app code; L11's fixture runs with it.
- **The 404 fallback** (a GET and a POST with a small JSON body to a random path that cannot match a route) warms the framework and its body parser, not the database driver. A route whose first request pays for the driver can look cold until a `warmup` route is configured.
- **Stacks:**
  - Node only; no Python set yet.
  - Database access through `pg` and Prisma; Drizzle is not read.
  - postgres.js, mysql2 and Knex pools are not counted.
  - Only Express, Fastify, `node:http` and Next.js handlers are found.
- **Static blind spots,** listed in `fixtures/PLAN.md` under Known gaps:
  - statements built at run time;
  - lists from the client;
  - queue-draining loops;
  - partial jitter;
  - other retry libraries and other pools;
  - growth, repeated work and set-up done through code ERLANG cannot follow;
  - an unknown Prisma version (batching assumed).
- **L09-4** (a small synchronous file read) is confirmed statically only, because no trace can separate it from the asynchronous read.
- **L09-5** (bcryptjs's asynchronous hash on every password change) is an expected miss of the trace: it yields between 100 ms slices, so its longest stretch is under the 70% share the trace requires. It is confirmed statically.
- **L12** (load shedding) is testable only under load.
- **No load forms for the Prisma twins,** by decision.
- **The held-out set** has not been planted or scored, so accuracy outside the fixtures is not measured.
- **Owner's services only.** The load harness refuses any target that is not a twin it started on loopback.
