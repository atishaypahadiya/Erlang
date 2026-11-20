# ERLANG run contract

What a caller, a CI job or another tool can rely on when it runs ERLANG. It describes ERLANG 0.0.1: the command `erlang`, below, and the trace harness, in its own section at the end. A change to anything here is a change to the contract and is recorded in this file.

## Invocation

```
node bin/erlang.js <dir> [--out <file>]
node bin/erlang.js --version
```

- `<dir>` is the root of the code to check, absolute or relative to the working directory. `--out <file>` may come before or after it.
- `--version` (or `-v`), alone, prints one line and exits 0:
  `erlang 0.0.1 (commit <40-hex SHA>): load and resilience checks (not the Erlang runtime)`,
  followed by ` (uncommitted changes)` when tracked files, staged or not, differ from that commit.
  The SHA is the commit ERLANG runs from, read from its `.git`. It is `unknown` outside a git checkout. Uncommitted changes are found with `git diff --quiet HEAD`. Untracked files do not count. When git cannot answer, no suffix is printed.
- Requirements: Node.js 22 or later, and `npm install` once in the ERLANG directory, which installs its one dependency, TypeScript 6.0.3.

Every form above is run by `scripts/cli-test.js`.

## Inputs

| Input | Needed | Notes |
|---|---|---|
| Path to the code | Yes | A directory. Source, SQL, `schema.prisma`, `package.json`, lockfiles, Dockerfiles and deployment files (Compose, Kubernetes, PM2, fly.toml, serverless.yml) under it are read. |
| `erlang.config.json` at the root of `<dir>` | No | `exclude` (paths not part of the app), `handlers` (entry points ERLANG cannot find), `smallTables`, `database.maxConnections`. Schema: `schema/config.schema.json`. A config that cannot be read refuses the scan. |
| URL of a running service | No | ERLANG runs nothing and sends no request. |
| Test logins | No | None are read or used. |
| Seed size | No | No database or data is used by the checks. |

No environment variable changes what ERLANG does.

What is not read:
- `node_modules`, `.git`, and build output: `dist`, `build`, `out`, `.next`, `.nuxt`, `.svelte-kit`, `.output`, `.vercel`, `.netlify`, `.astro`, `.turbo`, `.cache`, `coverage`;
- whatever the config excludes;
- symbolic links, which are never followed;
- files over 1 MiB, which are named in the report, which is then partial.

## Output

One file, a report/1 in JSON (UTF-8, two-space indent, trailing newline):
- at `<file>` when `--out` is given;
- otherwise at `dist/reports/<name of dir>/report.json` inside the ERLANG directory, not the working directory.

Each finding is also printed to standard output, one line per finding. A last line gives the status, the failing findings (errors and warnings) and the info findings counted apart, and the report's path: `complete: 2 failing (1 error, 1 warning), 3 info. Report: ...`. Standard output is for people; the report is the interface.

**report/1** (`core/schema/report.schema.json`, a copy of ITTEN's at release v0.3.5):
- `schema`: `"report/1"`. `specialist`: `"erlang"`. `version`. `subject`: the scanned directory, relative to the working directory, so a report does not carry an absolute path such as a home directory.
- `started`: UTC, to the second.
- `status`, one of:
  - `complete`: every check ran on every file;
  - `partial`: something could not be read, and `reason` names each file and why;
  - `refused`: nothing was judged, and `reason` says why.
- `findings`: a list of finding/1.
- `erlang`: the run data. `scope` holds the config, the excluded paths and notes. `checks` holds, per check, the counts of files, handlers and queries read, and of what was skipped and why.

**finding/1** (`core/schema/finding.schema.json`, ITTEN's at v0.3.5):
- `check`: one of `no-timeout`, `n-plus-one`, `per-row-writes`, `unbounded-query`, `pool-sizing`, `retry-policy`, `retry-budget`, `missing-index`, `pool-exhaustion`, `blocking-work`, `oversized-payload`, `memory-growth`, `no-cache`, `cold-start`, `no-load-shedding`.
- `severity`: `error`, `warning` or `info`. A MUST rule gives `error` and a SHOULD rule gives `warning`. Errors and warnings fail a run; info never does. `info` with `erlang.unresolved` means ERLANG could not decide, for example when no request handler was found or the database's limit is unknown.
- `fingerprint`: built from the check, the file and enclosing function (or table and column), and the kind of defect, with no line number, so it survives edits that move lines. Several of the same kind in one function are told apart by their order (`|2`, `|3`). Renaming the file or function changes it. A fingerprint never holds a value measured at run time (a count, a time, a size), so a finding keeps its fingerprint from one run to the next; declared values may appear, such as a route, a rule or an upstream host named in a trace form. The rule is shared with ITTEN and KERCKHOFFS.
- `message`: what is wrong, why it matters and what it rests on.
- `measured: []` and `floor: null`: nothing is measured by static checks.
- `detection`: `static`, and `config` when deployment or configuration files were read.
- `rules`: ids from `reference/`, such as `DAT-03`.
- `where.locations`: `{ file, line, column }`, with `file` relative to `<dir>`. The first location is where to act.
- `erlang`: ERLANG's own fields (`schema/finding-erlang.schema.json`). `strength` (MUST or SHOULD) and `fix` are always present; the rest depend on the check.

## Suggested fixes

Every finding of `erlang` carries a suggested fix in `erlang.fix`, of one of two kinds:

- **`auto`**: complete `edits`, each one edit unit (below). A `note` may add context, such as building an index concurrently in production.
- **`guided`**: `locations` and a `note`, for fixes that need judgement. No edits are given.

The edit unit is shared with ITTEN and KERCKHOFFS, from ITTEN's contract, so one fix step can apply any of the three's fixes:

- `{ file, line, column, length, replace }`: replace `length` characters at `line` and `column` with `replace`. `line` and `column` are 1-based; `column` and `length` count UTF-16 code units.
- `{ create: file, content }`: make a file, which must not exist. A new migration is made this way.
- `{ remove: file }`: delete a file, which must exist.

Every `file` is relative to the project root. `lib/fix.js` applies the unit and refuses, changing nothing, an edit whose file is outside the root or is build output, a position past the end of its line or file, a create of a file that exists, an edit or remove of one that does not, overlapping edits, and a file that one apply both edits and creates or removes. `scripts/unit-test.js` holds a case for each, and for UTF-16 columns and lengths.

ERLANG never applies a fix. Applying one is the caller's step. Every auto fix in the fixtures is applied and re-checked by `scripts/fix-test.js`: it must clear its finding, add none, and leave the code parsing.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Complete, with no failing findings (info findings may be present) |
| 1 | Failing findings (an error or a warning), whether or not the report is also partial |
| 2 | Refused: `<dir>` is not a readable directory, or its config cannot be read |
| 3 | Partial with no failing findings: a file could not be read, so the silence vouches for nothing |
| 64 | Bad usage (`EX_USAGE`) |
| 75 | Temporarily blocked, nothing judged, retry later (`EX_TEMPFAIL`). `erlang scan` measures no time and never returns it; the trace and load harnesses do, when ITTEN's timing lock keeps them from measuring (below). |

These codes, and the rule that error and warning fail a run while info never does, are shared with ITTEN and KERCKHOFFS.

A refused or partial report is still written. An error inside one check stops only that check, and the report is partial and names it.

## Network

None. `erlang` opens no socket, sends no request and generates no load. It starts no process, except `git diff` for `--version`. The only network use is `npm install`, which fetches TypeScript from the npm registry once.

## Writes

- **The report file only:** at `--out <file>`, wherever that is, or else under `dist/reports/` in the ERLANG directory. Its parent directories are created.
- **Nothing in `<dir>`:** ERLANG does not write, create or modify anything there, and suggested fixes are not applied.
- **Nothing else:** no cache, temporary file, log or home-directory state.

## Timings

No finding of `erlang` rests on a timing. Where ERLANG judges a timing (the load harness), the shared timing lock applies (`lib/timing.js`): a timing-based finding counts only when it was measured at least 3 times with a relative spread, (max − min) / median, of 10% or less, and the 1-minute load average was below half the CPU count before and after. Otherwise the finding is `info`, with the reason `timing unreliable` and the environment recorded, and it never fails a run.

## Continuous integration

`.github/workflows/ci.yml` runs `npm ci` and `npm test` on every push to `main` and every pull request, except those that change only Markdown (`paths-ignore: ['**/*.md']`), and on every pushed `v*` tag. The rule is shared with ITTEN and KERCKHOFFS.

## Determinism

- Two runs on the same files give the same report apart from `started`: the same findings, in the same order, with the same fingerprints, messages and fixes. Checks run in a fixed order, and files are read in sorted order.
- The working directory changes only `subject`.
- No clock, randomness, network or environment variable enters a finding.
- The report changes when the files change, or when ERLANG's version or commit does.

## Scope and limits

- Static checks only: ERLANG reads source and configuration and judges what they say.
- Request handlers are found in Express, Fastify, `node:http` and Next.js. Database access is read through `pg` and Prisma.
- Known false negatives and positives are listed in `fixtures/PLAN.md`, under Known gaps.
- ERLANG is for the owner's own code and services only.

## The trace harness

A separate program, for ERLANG's own fixtures: `scripts/trace.sh` (`npm run trace`). It confirms static findings by what a served twin does, on a real database: statement and row counts, outbound calls, pool counts, and whether a response comes at all. It is not part of `erlang` or `npm test`. Design and decisions: `research/trace-harness.md`.

```
scripts/trace.sh [form ...]      e.g. scripts/trace.sh L01a-n-plus-one/sql
```

With no form, it runs every `fixtures/<id>/<form>/trace/trace.json`: today the `sql/` and `prisma/` forms of L01a, L01b, L02 and L03, L04's `sql/` form, L05, L06's `loops/` form, L07, L08, L09, L10, L11, and L13's `compose/` and `kubernetes/` forms. L12's trace cell is covered by its load cell (docs/decisions.md, Q3).

**Inputs**

| Input | Needed | Notes |
|---|---|---|
| Docker | Yes | Runs `postgres:17.11@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f`, the image KERCKHOFFS pins. |
| A fixture form | Yes | Its twins, and `trace/`: `trace.json` (the requests or page views, how the stub answers each, and the expected defects), `seed.sql`, a schema (`schema.sql`, the twins' own migrations, or, for a Prisma form, each twin's `prisma/schema.prisma`, rendered to SQL by `prisma migrate diff`, which connects to nothing), and `package-lock.json`. Optional: `package.json`, when the twins ship none, and `overlay/`, files copied over the twin's copy (L07's driver, a server over a library). |
| Seed size | Fixed | Each form's `seed.sql`, at 1x and 10x. For example, L02 has 10,000 orders and events at 1x, and 100,000 at 10x. The seed is deterministic, and its SHA-256 is recorded. |
| URL | No | Each twin is started by the harness, on 127.0.0.1, on a port the system picks. |
| Test logins | No | The fixtures have no authentication. The database passwords are made for each run. |

**Output.** For each twin, in `dist/trace/<id>/<form>/<twin>/`:
- `raw.json`: every count;
- `report.json`: a report/1;
- `twin.log`: the twin's own log.

Trace findings are finding/1:
- `detection` includes `trace`.
- `erlang.trace` holds what was judged (`judge`): counts at each scale and the slope or ratio, the attempts an upstream host received, the connections checked out of the pool, or whether the response came. A judgement on a time carries the timing lock's verdict in `erlang.trace.timing`; when the lock does not hold, the finding is `info` with reason `timing unreliable` and never fails.
- `measured` is `[]`, since counts do not vary between runs.
- What is judged, by form: statements and rows per request (pg_stat_statements); the statement log with its parameters (`log_statement`, for repeated reads, L10); plans (`auto_explain`, for sequential scans, L03); outbound attempts at the stub (L06, L07); pool and connection counts (L08, L13); the event loop's longest blocked stretch (L09); heap after a full collection, over a soak (L05); and the time of a fresh process's first request against its later ones (L11).
- Request templates: `$n` (the items at this scale), `$i` (an item's index inside `{ $repeat }`), `$list` (`1,2,...,n`, for ids in a query string) and, in a body, `$run` (the run's index, for values that must differ per run).
- A finding that agrees with a static finding (same check and rule; same method and route, or, for code no handler reaches, the symbol the trace names; and the statement that grows on one of its lines, except for Prisma, whose source holds a model call rather than SQL) is that static finding, with `trace` added to its `detection` and the counts added to its message. Its fingerprint, locations and fix stay the static finding's.
- A trace finding with no static match names its endpoint. It carries a guided fix when its statement or route is found in the source.

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | Every form as expected: each planted twin reports exactly its defects, linked where `trace.json` says, and each clean twin reports no error or warning |
| 1 | A form was not as expected, or its run failed |
| 3 | Nothing failed, but in a timed form (trace: L09, L11; every load form) a planted defect was reported only as `timing unreliable`, so the form is not confirmed (`UNRELIABLE`, never `PASS`) |
| 2 | Cannot run: Docker is not running, PostgreSQL did not start, or the port is bound beyond 127.0.0.1 |
| 64 | Bad usage |
| 75 | Temporarily blocked, nothing judged, retry later (`EX_TEMPFAIL`): ITTEN's timing lock stayed active past the wait, read at start and immediately before each twin, waited on, rereading about once a second, for `ERLANG_LOCK_WAIT_S` seconds (600 by default), and named in the message (`research/itten-lock.md`). |

**Network**
- PostgreSQL publishes its port on 127.0.0.1 only. Each twin listens on 127.0.0.1 only, whatever host and port it asks for. Requests go only to the twin, one at a time, at most 5 a second, three per request per scale (two for requests that wait out a timeout), apart from soaks.
- Every outbound HTTP call a twin makes (`node:http`, `node:https`, `fetch`, and the clients built on them) goes to a stub the harness runs on 127.0.0.1, as plain HTTP, with the host it meant in `x-erlang-host`. Nothing a twin calls leaves the machine.
- No load is generated. Soaks (L05) send one request at a time, at most 50 a second.
- The first run pulls the image from Docker Hub, and installs each form's packages from the npm registry with `npm ci --ignore-scripts`, from its committed lockfile. For a Prisma form it then runs `prisma generate`, whose first use downloads Prisma's schema engine from Prisma's download host; `CHECKPOINT_DISABLE=1` keeps the CLI from sending its usage check. Later runs reuse all of it.

**Writes**
- `dist/trace/`: results; installs, in `dist/trace/install/`; and the run's passwords, in a mode-700 directory, `dist/trace/run/<pid>/`, removed on exit.
- One Docker container, removed on exit, including on failure. The image stays in Docker's store.
- Nothing in `fixtures/`: each twin is copied to `dist/` before it runs.

**Determinism.** The seeds use no randomness, and the counts are exact. For each of the four first forms, two consecutive runs gave reports identical apart from `started`, for both twins. Timings are judged only under the timing lock (three or more samples, relative spread of 10% or less, one-minute load average below half the CPU count before and after); otherwise the finding is `info`, and a planted defect judged that way is reported as `UNRELIABLE ... timing unreliable`, with its samples, spread and load averages: neither missed nor passed, and the run exits 3 unless something else failed. Count-based forms never produce one.

**Load on the machine.** Everything runs at `nice -n 15`. The container is held to one CPU and 1 GB. A full run of the nineteen forms takes about twenty minutes, most of it L07 waiting out timeouts and L05's soaks.

## The load harness

A separate program, for ERLANG's own fixtures: `scripts/load.sh` (`npm run load`). It serves a form's twins on 127.0.0.1 against PostgreSQL, as the trace harness does, and drives them with k6 at a fixed arrival rate, each twin judged against the other. Design: `research/load-harness.md`.

```
scripts/load.sh form ...         e.g. scripts/load.sh L12-no-load-shedding
```

Each form's `load/load.json` lists its steps (method, path, rate, seconds, the latency that counts as served in time, a timeout), which steps are controls and which are judged, how many repeats, and the expected defects. Schema, seed and lockfile come from `load/` when the form has its own, else from `trace/`.

**k6.** The `k6` on the path, or `ERLANG_K6`; with neither, the run stops (exit 2) with an install hint. ERLANG never installs, vendors or links k6. Each step's script is written at run time into the form's output folder; k6 runs it with `--no-usage-report`, so it sends nothing about the run anywhere. CI installs k6 v2.3.0 from Grafana's release, checked by SHA-256.

**The guard** (`lib/load-guard.js`). The target is only ever the twin the harness started, on the loopback interface, over plain HTTP; any other host is refused, and no flag widens it. Caps, refused before anything runs (exit 2):

| | Rate | A step | A run | Forms per run |
|---|---|---|---|---|
| CI (`CI=true`) | 500 a second | 60 s | 1,200 s of load | any |
| CI, a form in its own job (`ERLANG_LOAD_PROFILE=ci-long`; L05) | 500 a second | 60 s | 2,400 s of load | one |
| A workstation | 200 a second | 20 s | 600 s of load | one |

**ITTEN's timing lock** is read before each step and every 5 seconds during it. A lock that appears mid-step stops k6 and voids that twin's repeat, which runs again from a fresh database and server once the lock is gone; after five interruptions of one repeat the run stops with exit 75. At the wait's limit the run stops with exit 75, naming the lock.

**Judges.** `shedding` (L12): past the knee, the share of requests served in time, against the twin's share below it. `compare` (every other row): each judged step names one quantity, and a twin reports when its median over the repeats is at least the step's `ratio` times the other twin's and at least its `floor`:

| Metric | The quantity, per step | Rows |
|---|---|---|
| `statements` | statements per request (pg_stat_statements) | L01a, L01b, L10 |
| `rows` | rows the statements returned per request (pg_stat_statements) | L02 |
| `blocks` | shared blocks the statements read per request, hit or from disk (pg_stat_statements) | L03 |
| `bytes` | bytes on the wire per response, k6 offering gzip and br | L02, L04 |
| `median`, `p90`, `p99` | latency of the requests served | |
| `heap-slope` | heap kept per request: the least-squares slope of the heap after full collections (about every 2 s) against responses answered, positive in every repeat | L05 |
| `loop-max` | the event loop's longest stretch over the step (monitorEventLoopDelay), with a `background` | L09 |
| `attempts` | calls the stub received from one failing host, per request | L06 |
| `stub-open` | calls held open at a hanging host, at most | L07 |
| `failed` | share of requests that failed | L08 |
| `late-share` | share not answered within `okMs`; with a `background` (a second route at its own rate), the finding is about the background route | L09 |
| `max` | the slowest response, after a restart (`restart`) | L11 |
| `connections` | connections open at the database, at most | L13 |

A step's paths must start with a single `/` and resolve to the twin's own origin; anything else is refused.

**Judging.** Each twin against the other, never against an absolute number. A verdict on a count, or on a share with no time limit in it (`statements`, `rows`, `blocks`, `attempts`, `stub-open`, `connections`, `bytes`, `failed`), is exempt from the timing rule: always judged, with the load averages recorded as information and `exempt: true` in `erlang.load.timing`. `heap-slope` is gated on the spread of the slopes over the repeats (at least 3, 10% or less), not on the load average. Every other load finding (latencies, `loop-max`, `late-share`, the shedding gap) goes through the timing rule: the judged quantity in each repeat (at least 3), a relative spread of 10% or less, and the one-minute load average below half the CPU count before every step and after it, "after" read once the harness's own load has stopped and the average has fallen (up to 120 s; docs/decisions.md, Q6). Otherwise the finding is `info`, `timing unreliable`, and never fails; a planted defect judged that way is reported as `UNRELIABLE`: neither missed nor passed. A finding that agrees with a static finding (check, rule, and the symbol or endpoint) is that finding, with `load` in its `detection` and the measurements in `erlang.load`; its fingerprint stays the static finding's, and never holds a measured value.

**Expected misses.** A form's `expectedMisses` names planted defects below its measure's detection floor, each with the floor stated (L05's `createOrder`: a leak under about three times the clean twin's own retention). They stay in the fixture as the hard case: the planted twin need not report them and the run says whether it did; the clean twin must still report nothing there.

**Candidate rule (c)** (docs/decisions.md, Q8; not adopted): for timed relative verdicts, at least 5 repeats; a finding holds when every repeat clears the threshold, none clearing is no finding, a mix is `timing unreliable`; spread and load average recorded only. Both judges print it beside the current rule on a `TRIAL` line; the exit code is the current rule's.

**Output.** `dist/load/<id>/<form>/raw.json` (every step of every repeat: counts of requests served in time, late, refused and failed, latency percentiles, the twin's probes, the load average before and after), the k6 scripts and summaries, and `<twin>/report.json`, a report/1.

**Exit codes**: as the trace harness's; 2 also when k6 is missing or a step is over its caps. A form passes only when the planted twin yields a failing finding for every defect under the timing rule and the clean twin reports no error or warning; a planted defect reported only as `timing unreliable` makes the form `UNRELIABLE`, printed with its samples, spread and load averages, and the run exits 3 unless something else failed.

**Network and writes**: as the trace harness's. Load goes only to the twin, on 127.0.0.1.
