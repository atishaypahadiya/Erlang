# Changelog

## 0.1.0

The first release. Built and fixture-tested: every planted defect in Erlang's own fixtures (L01a to L13) is found, and no clean twin reports anything (recall and precision 1.00), statically, by trace and under load, on five consecutive CI runs whose trace reports agree. Nothing is claimed for code outside the fixtures; the held-out set has not been planted or scored. finding/1 and report/1 come from a pinned copy of the shared core, to be re-pinned when it gains expected rows.

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
  - The heap slope is judged per pair, and a pair counts only with a fit of R² 0.5 or better (the trace's soaks need 0.9).
  - Timed verdicts (latencies, the event loop's longest stretch, late shares, the shedding gap) are judged under the relative timing rule.
- **Headroom:** `scripts/trace.sh --headroom` measures each load form's clean twin, one request at a time: at every step's rate, its main thread must be busy at most 0.2 of the time, or a verdict that compares the twins under load would turn on the machine's speed. CI checks every form.
- **Postgres** is pinned by digest, with a random password per run, and the container is removed afterwards.
- **Local smoke:** `npm test` ends with `scripts/load-smoke.sh`: one load form for a few seconds per twin, priming start included and nothing judged. It is skipped, with a message, when k6 or Docker is absent or ITTEN's timing lock is active, and it notes when the local k6 differs from CI's (v2.3.0).

### Timing rules

- **Count-based verdicts** never depend on the machine's load.
- **The relative timing rule (c):** for a verdict comparing two conditions measured together. Five repeats; a finding when every repeat clears the threshold, none when no repeat does, and unreliable (info, never failing) for a mix. Pairs alternate twin order. Spread and load average are recorded but gate nothing.
- **Absolute waits** (L06's fixed wait between retries): judged on the delay the code declares, recorded from the twin's timers (the global `setTimeout`, `node:timers`, and `node:timers/promises`' `setTimeout` and `scheduler.wait`), not on a clock; no load average or spread gates it. Retries spaced apart with no timer seen are info, "wait not observed", never clean.
- **Priming start:** before the judged repeats of a timed form, trace or load, each twin is started once with the warm-up and one request per judged route; nothing from it is judged, and its figures are kept in the raw output, marked unjudged.
- **Planted margin:** the fixture suite fails when the median of a planted defect's samples clears its bar by less than 2x (for a share bounded by 1, half way to 1 when twice is past it), or when any one sample falls below the bar.
- **Headroom** is judged on the median of ten measurements a step, one a request, each with the garbage collections inside it; two or more measurements over 0.3 fail outright, and a single one is printed as an outlier with its collection time. It fails only on judged steps; warm-up steps are printed.
- **Decoy margin:** in a timed form, the median of every decoy's samples stays at most half way to its bar on at least one of the bar's conditions, and no single sample reaches the bar; the judges print it on `DECOY` lines.
- **Outliers:** a single sample past a margin but inside the bar is printed on an `OUTLIER` line with its diagnostics, not failed: one-off stalls on shared runners move one sample, not the median. Both margins cover the heap slope too.
- **Diagnostics in CI:** every run uploads the twins' `raw.json`, their logs (every garbage collection) and the database server's log, for the trace, headroom and load jobs.
- **ITTEN's timing lock:** the harnesses generate no load while it is active. They wait and log every wait (phase, taken, expires, duration). A lock in an unknown format counts as active. A running Lima VM (`limactl list`) counts as a lock too: a benchmark harness on the same Mac runs 2-CPU VMs, and the harnesses wait while one runs, logging the wait with the VM's name; where limactl is absent, as in CI, nothing changes.

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

A `v*` tag is cut only when its commit's last five CI runs are green and their trace reports are identical apart from what each finding lists as measured, as is a local run on a second machine (`docs/CONTRACT.md`, "Release gate"; `scripts/release-gate.sh`). Every planted row's finding must be present in all five runs with the same rule, severity and fingerprint, and never read "timing unreliable"; no row with nothing planted may be an error or a warning. An info "timing unreliable" on a row with nothing planted is counted and printed rather than compared, and the gate fails if one row has one in two or more runs, or one run has more than two. CI checks the gate again on the tag.

### Findings

A trace or load finding carries the values its message quotes: `erlang.values.measured` (what the run measured), `erlang.values.declared` (what the code, the fixture or the judge declares) and `erlang.template` (the message with each value as `{name}`). finding/1's `measured` lists the measured paths, so runs are compared by template and declared values without knowing any check. Proposed for the shared format (`docs/CONTRACT.md`).

### Judge fixes

- **Load heap slope (L05):** a slope fitted to noise could previously clear the bar. A pair now counts only when its fit has R² 0.5 or better, for planted and decoy rows alike (CI run 44783787423: L05's decoy orderLines cleared in one pair at 130.5 B/request with R² 0.08).

### Fixture checks

- **The planted twin answers (load):** a load step whose planted twin fails or refuses any request, in any repeat, fails the form, unless `load.json` says why failures belong to it (`plantedFailures`).

- **L11's countries:** the seed loads 75,000 countries, not 50,000, so the planted first request under load sits at an estimated 1.5 times its margin on CI rather than 1.13 (fixtures/PLAN.md).

### Harness fixes

- **Database volumes:** each run's database lives in a volume of its own, named and labelled `erlang.trace`, and removed at the end of the run; leftovers of a killed run are removed by the next. Before, the image's anonymous volume was left behind on every run.

### Release gate fixes

- A report lists its own measured run-level paths in `erlang.measured` (the trace's warm-up times), and the comparison drops them as it drops a finding's: until now, the four L11 trace reports differed in every pair of runs on their warm-up times alone, so the gate could not hold.

### Known limits

- **Detection floor (L05).** A leak under about 512 bytes a request (trace), or under three times the clean twin's own retention per pair (load), is not detected. L05's `POST /orders`, about 83 to 215 bytes an order, is kept as a documented expected miss. It is reported on an EXPECTED line, not deleted.
- **Thin margins,** all on Erlang's own fixtures (none crossed on the last two CI runs):

  | Form | Quantity | Observed | Bar |
  |---|---|---|---|
  | L05 trace | placeCart's fit | R² 0.95 to 0.96 | 0.9 |
  | L05 load | createOrder's closest pair | 193 B/request | 203 |
  | L09 load | clean twin's signup stretch | ≤ 34 ms | 50 |
  | L11 load | decoy price | ≤ 53 ms | 80 |
  | L11 trace, warm-up form | decoy above the baseline | 4 to 7 ms | 20 |
  | L11 trace, fallback form | clean twin's largest extra | 12 ms | 25 |

- **Routes that commit on L11:** a route whose first request writes to the database can read "timing unreliable" in the cold-start trace, because each commit waits on the disk's flush and that wait varies by several milliseconds. The remedy for a trace database is `synchronous_commit = off`, set on the database (trace.json `database`), not in app code; both of L11's forms run with it.
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
  - growth, repeated work and set-up done through code Erlang cannot follow;
  - an unknown Prisma version (batching assumed).
- **L09-4** (a small synchronous file read) is confirmed statically only, because no trace can separate it from the asynchronous read.
- **L09-5** (bcryptjs's asynchronous hash on every password change) is an expected miss of the trace: it yields between 100 ms slices, so its longest stretch is under the 70% share the trace requires. It is confirmed statically.
- **L12** (load shedding) is testable only under load.
- **The name in capitals.** Some printed messages still write the name as ERLANG. They change in 0.1.1, so that the check and judge code scored for 0.1.0 is not edited before scoring.
- **The trace and load judges differ** (an audit of 20 November 2026; no judge changed for 0.1.0). Each form's two harnesses measure different quantities with their own bars, so one can find a defect the other misses. The two marked **0.1.1** are to be fixed first.
  - **0.1.1: error statuses.** The trace stops on any error status (400 or over) from a judged request; the load judge has no such check, so a twin that answers errors is judged on what it measured. Affects the load forms of L01a, L01b, L02, L03, L08, L09, L10, L11 and L13 (L12 has only its below-the-knee control). Since 0.1.0 a planted twin that fails requests, errors included, fails the fixture check, unless its form says failures belong to it; the clean twin's errors are not checked.
  - **0.1.1: agreement across runs.** In the trace, a count must come out the same in every run, and a mix is reported as info. Under load, a count is the median of three repeats with no agreement check, so one odd repeat is outvoted. Affects the load forms of L01a, L01b, L02, L03, L04, L06, L07, L08, L10 and L13.
  - **In-between results:** the trace reports a count in its uncertain band as info; under load a step either clears or reports nothing. L01a, L01b, L02, L04.
  - **Linking to a static finding:** the trace needs the repeated statement on a source line; the load judge links on check, rule and route alone. L01a, L01b, L02, L03, L10.
  - **Severity:** under load a finding that is not linked to a static finding is always a warning; the trace takes the severity from the rule. It matters only for a decoy or an unresolved static finding. Every load form.
  - **One twin against the other:** under load each twin is judged against the other, so a defect both twins have is not seen; the trace judges each twin alone. Every load form.
  - **Small tables:** the trace leaves out tables it declares small (`countries`); under load the countryByName decoy is held off only by the ratio to the other twin. L03.
  - **Defects with no load step:** L02's streamed decoy (`exportEvents`); L04's DAT-01 on `/products/:id/price` and DAT-08 on `/products` (load covers 2 of 4); L06's two RTY-03 defects (`accounts.test`, `recs.test`; a missing wait changes no count); L07, 1 of 10 defects; L08's STB-08 connections kept after the response (`dailyReport`, `importRows`); L09's expected miss, `PUT /password`; L13's `daily` decoy.
  - **Conditions one side lacks:** L06's RTY-06 under load has no condition on the status class (the trace needs a 4xx other than 408 or 429). L09 under load has no share-of-the-request condition and no warm-up run per step (the trace drops its first of six), and its `codes` decoy has no trace counterpart. L11 under load has no warm-up or full collection before a step's first request beyond the priming start, and its bar is 80 ms and 5 times the other twin's against the trace's 20 ms and 3 times a baseline. L05 under load does not check that each heap reading followed a full collection, a pair with too few points simply does not clear (the trace stops), its fit needs R² 0.5 against the trace's 0.9, and the trace's soaks have no margins.
  - **Fixture checks only under load:** headroom and L09's `cleanMax` have no trace counterpart.
- **No load forms for the Prisma twins,** by decision.
- **The held-out set** has not been planted or scored, so accuracy outside the fixtures is not measured.
- **Owner's services only.** The load harness refuses any target that is not a twin it started on loopback.
