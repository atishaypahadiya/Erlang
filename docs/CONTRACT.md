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
| `erlang.config.json` at the root of `<dir>` | No | `exclude` (paths not part of the app), `handlers` (entry points ERLANG cannot find), `smallTables`, `database.maxConnections`, `warmup` (a cheap GET or HEAD route the trace harness requests in each fresh process before timing first requests; without it, a path that does not exist, a 404 that warms the framework but not the database driver, and the report says which ran). Schema: `schema/config.schema.json`. A config that cannot be read refuses the scan. |
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
| 70 | Internal failure (`EX_SOFTWARE`): a crash, not a refusal and not bad input, including a module that fails to load (`bin/erlang.js` imports nothing statically and loads the command inside a guard). Stderr says `internal failure` and gives the error; no report is promised. Before 0.1.0 a crash exited 1, Node's default, which read as failing findings. An error inside one check is not a crash: that check stops and the report is partial (3). |
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

No finding of `erlang` rests on a timing. Where the trace and load harnesses judge time, one of two rules applies. A relative verdict (two conditions measured together) is judged under the relative timing rule below. An absolute wait is judged under the rule for absolute waits below. A relative finding that cannot be judged is `info`, with the reason `timing unreliable` and the environment recorded, and it never fails a run. No verdict is gated on the shared timing lock's load-average condition any more (`lib/timing.js` `judge` remains for the other tools' use).

**Absolute waits** (the owner, 20 November 2026; L06's fixed wait between retries, RTY-03). A wait the code declares is judged on the value it declares, not on a clock: the twin's timers (`setTimeout`, global or from `node:timers/promises`) are recorded as the code set them, and for each gap between two attempts, the longest timer set after the one attempt that fired by the next is that gap's wait (a request deadline outlasts the gap; a jittered wait can be any length). Every wait of every run, warm-up included, declared alike, three waits or more, is a fixed wait with no jitter. No load average, spread or sample count gates it, since nothing measured enters the verdict. The harness records the global `setTimeout`, `node:timers`' `setTimeout`, and `node:timers/promises`' `setTimeout` and `scheduler.wait`. A gap of 20 ms or more between attempts with no recorded timer in it is reported as `info`, "wait not observed", never as a clean result. This replaces judging the measured gaps under the timing lock, which a busy machine made `timing unreliable` though six gaps lay within 0.3% (1,000.6 to 1,003.4 ms).

**The relative timing rule** (`lib/timing.js` `ruleC`; the owner, 19 November 2026, docs/decisions.md Q8). A timed verdict that compares two conditions measured together (the two twins of one pair in a load form; two requests of one run or start in a trace form: L09's blocked stretch against the request's own time, L11's first request against the cheapest route's in the same process) needs at least 5 repeats. It holds when every repeat clears the threshold on its own, there is no finding when none does, and a mix is `info`, `timing unreliable`, which never fails; a planted defect judged that way makes the form `UNRELIABLE` (exit 3), never a pass. Pairs alternate twin order (planted first, then clean first), so a slowdown tied to run order cannot favour one twin. Spread and load average are recorded but gate nothing for relative verdicts. It applies to L09, L11 and L12, in their load and trace forms.

## Continuous integration

`.github/workflows/ci.yml` runs `npm ci` and `npm test` on every push to `main` and every pull request, except those that change only Markdown (`paths-ignore: ['**/*.md']`), and on every pushed `v*` tag. The rule is shared with ITTEN and KERCKHOFFS.

## Release gate

A commit is tagged `v*` only when the release gate holds for it (`scripts/release-gate.sh`, run before tagging and again by CI on the tag, job `release-gate`):

1. Its last five completed CI runs are all green, with no red run among them. The tag's own run is left out; `workflow_dispatch` reruns the workflow on the same commit.
2. The trace reports those runs uploaded (artifact `trace-reports`) are identical across them, and identical to a local trace run on a second machine, apart from what each finding itself lists as measured (`scripts/compare-reports.js`, which decides nothing per check):
   - the paths in the finding's `measured` (finding/1), including its measured values (`erlang.values.measured`) and the measured fields of its evidence (`erlang.trace`, `erlang.load`);
   - `message`, when the finding carries its template, which is compared instead; without one, the message is compared with its numbers masked, as finding/1 reads `"message"`;
   - the report's `started` and `environment`;
   - an info "timing unreliable" finding on a row with nothing planted (below).

   Everything else must match: the set of findings, their verdicts, rules, severities, fingerprints, locations, fixes, counts, declared values and message templates.
3. The rows hold in every run (the owner, 20 November 2026). Each report is read with its fixture's `trace.json`: a planted row is one of its `defects` in the planted twin; every row of the clean twin, and every row of the planted twin that is neither a defect nor an expected miss, has nothing planted.
   - **Absolute:** every planted row's finding is present, as an error or a warning, in all five runs, with the same rule, severity and fingerprint. A planted row reading "timing unreliable" in any run fails the gate. No row with nothing planted is an error or a warning in any run.
   - **Tolerated:** an info "timing unreliable" on a row with nothing planted does not make two reports differ, since a one-off stall on a shared runner can put a single start of a decoy past the bar while every verdict stays right. The gate counts them and prints each with its row and run (`UNRELIABLE-INFO`, `UNRELIABLE-COUNT`), and fails if the same row has one in two or more of the five runs (`UNRELIABLE-REPEATED`), or any single run has more than two (`UNRELIABLE-RUN`).

If the gate does not hold, nothing is tagged; the differing form is reported with each run's measured values.

## Fixture database settings

A trace form may set its fixture database's settings in trace.json `database`, applied with `alter database` when the database is made, so that every session of either twin has them and no app code sets them. Only `synchronous_commit` (`on`, `off` or `local`) is allowed. Both of L11's forms run with `synchronous_commit = off`: a commit returns before its WAL reaches disk, so a write's time no longer swings with the flush (the owner, 20 November 2026). Nothing the trace judges depends on durability.

## Priming start on a real project

Before the judged repeats of a timed form, the trace and load harnesses start each twin, or the app, once more (the owner, 20 November 2026). That start gets a fresh database, the same warm-up as a measured start (the form's own route, the app's `warmup`, or the fallback's GET and JSON POST to a random path, then a full collection), and one request to each judged route: in a trace, each route the judge reads; under load, each judged step's request and its background's, with `$i` replaced by a number no step uses. Then it is stopped, and nothing from it is judged. Its figures are saved in the raw output under `priming`, marked `"unjudged": true`. The number of judged repeats is unchanged.

It takes out of the first judged repeat the costs that belong to the machine, not to the code: a cold disk cache, a database server's first sessions, the first process to load the code. In seven CI runs before it, the twin that went first had its highest first-request time in pair 1 in six (L11's price step: 629.5, 350.7, 42.6, 39.0, 28.9 and 89.7 ms against 6.8 to 48.2 in pairs 2 to 5).

A form is timed when a verdict reads a time: under load, a step whose metric is not a count (`COUNT_METRICS` in `lib/timing.js`); in a trace, the judges `loop` and `starts` (`TIMED_TRACE_JUDGES`).

## Margins in the fixture suite

Two checks on ERLANG's own fixtures, never on a real project's findings (the owner, 20 November 2026; `fixtures/PLAN.md`; `lib/margin.js`). They apply to every timed row, trace and load, the heap slope included:

- **Decoy margin:** on the median of a decoy's samples, some condition of its bar is at most half way to it.
- **Planted margin:** on the median of a planted defect's samples, every condition of its bar is cleared by 2x: twice the time or count, twice the ratio times the other twin's value. For a share bounded by 1 (a late share, the loop's share of a request), twice the bar when that is at most 1, else half way from the bar to 1 (L09's trace: a share of 0.85 for the 0.7 bar). Expected misses are printed and skipped.
- **Single samples:** separately, a decoy fails if any one sample reaches the judge's own bar (clears it as a finding would), and a planted defect fails if any one sample falls below it. A sample past the margin but inside the bar is an outlier: printed on an `OUTLIER` line with its diagnostics (the load average; for a start, the later requests' median, the collections during the first request and the database's writes since the seed), never failed.
- **Headroom:** each step's clean twin is measured request by request (ten after the warm requests), each measurement with the garbage collections inside it. The median busy share must be at most 0.2, and any single measurement over 0.3 fails outright. Only judged steps can fail; unjudged steps (warm-ups) are printed with their figures.

Why the median: one-off stalls on shared runners. A CI runner shares its CPUs, and a single sample can take a stall that has nothing to do with the code: a collection, a neighbour's burst, the first touch of a page. Such a stall moves one sample, not the median. The margins exist to show that a fixture's rows sit well clear of the bars on a slower or busier machine, which the median shows; a single sample past the judge's own bar is still a failure, because there the verdict itself would change. In CI runs 44725479816 and 44755685238 every verdict was right, yet margin and headroom checks on single samples failed: L11's clean price route, 11.18 ms over its baseline in one start of five (1.02 to 1.19 in the others); L09's codes step at 0.241 busy on a runner where the same step measured 0.031 one run before.

## Trace diagnostics

Every trace run records, for explaining a timing after the fact (the owner, 20 November 2026; none of it is judged):

- the database server's log, with every checkpoint and every autovacuum and its time (`log_checkpoints`, `log_autovacuum_min_duration = 0`), in `dist/<mode>/postgres.log` (trace, headroom, load);
- every garbage collection in the twin, with its wall-clock time, kind and duration, in the twin's `twin.log`;
- for each start (judge `starts`): the rows and WAL the database had taken since the seed and the checkpoints since it, and, for each route's first request, its wall-clock time and the collections that ran during it, in `raw.json`;
- for each headroom measurement: its main-thread time and the collections inside it, in `headroom.json`.

CI uploads them beside the reports: artifact `trace-diagnostics` (the trace and headroom runs' `raw.json`, `twin.log`, `headroom.json` and database logs), `load-diagnostics-<n>` for each load job and `load-long-diagnostics`, kept 30 days.

Two measured runs of one request are compared on everything but the fields the run lists as measured (`RUN_MEASURED` in `lib/trace-judge.js`: its time, bytes, the load average, the loop and the pool before it), through the same path mechanism as finding/1's `measured`.

## Warm-ups and collections on a real project

Before measuring the first requests after a start (judge `starts`, cold-start), the trace harness sends a warm-up to the fresh process, then forces a full garbage collection (the process runs with `--expose-gc`), so that garbage left by the start is not collected inside a measured request. The warm-up is the form's own route (trace.json `warmup`), else the app's (`erlang.config.json` `warmup`, a GET or HEAD), else the fallback: a GET, then a POST with a small JSON body (`{"erlang":"warm-up"}`), to `/__erlang/warm-up-not-found-` followed by a random suffix new at every start, which cannot match a real route. Both are expected to answer 404 (anything under 500 is accepted); they warm the framework's routing and its body parser, and change nothing. The GET's own time is the baseline. They do not warm the database driver: a route whose first request pays for it can look cold until a `warmup` route is configured. (The owner, 20 November 2026.)

## Measured and declared values (proposed for finding/1)

A finding of the trace and load harnesses carries the values its message quotes, apart from the message (`lib/values.js`; the owner, 20 November 2026):

- `erlang.values.measured`: what this run measured (times, counts, slopes, shares, attempts so far), which differs between runs of the same subject;
- `erlang.values.declared`: what the code, the fixture or the judge declares (a wait the code asks for, a bar, a scale, a step's rate), the same in every run;
- `erlang.template`: the message with each value replaced by `{name}` (a literal brace written `{{` or `}}`). The message is the template with the values filled in, so the template is the same in every run that reaches the same verdict.

finding/1's `measured` lists, for such a finding, `message`, `erlang.values.measured` and each measured field of its evidence. A comparison then needs no knowledge of any check: it drops what `measured` lists and compares the rest in full, the template and the declared values included.

**Proposal for the shared format.** Move `values` (`measured`, `declared`) and `template` from ERLANG's extension into finding/1, beside `measured`, as optional fields: a specialist that fills them lets any consumer compare findings across runs by template and declared values, and show measured values as data rather than parse them out of prose. finding/1's `measured` paths stay as they are; `"message"` in them keeps its meaning (the numbers in the message) for findings without a template. To agree with ITTEN and KERCKHOFFS before it changes the shared schema.

## Decoy margin

In a timed form, every decoy stays at most half way to the bar it is judged against (the owner, 20 November 2026), so that a slower or busier machine cannot carry it over. A decoy is every judged route or step of the clean twin, and every one of the planted twin that is neither a planted defect nor an expected miss. A verdict needs every condition of its bar, so a decoy is held off by any one of them: on the median of its samples, some condition is at most half its threshold: the event loop's longest stretch (50 ms) or its share of the request (0.7); a first request's extra over the baseline (20 ms) or its ratio to it (3); in a load step, the floor or the ratio to the other twin (for a heap slope, per pair). The trace and load judges print each decoy's samples and medians on a `DECOY` line, each single sample past the margin on an `OUTLIER` line, and fail the form when the median is over or a sample reaches the bar (see "Margins in the fixture suite").

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
- A soak (`judge` `memory`, L05) is judged on the twin alone, the rule a project gets with no twin to compare against: a positive least-squares slope of the heap after full collections, 512 bytes a request or more, with a fit of R² 0.9 or better (`erlang.trace.slope`, `erlang.trace.r2`). A smaller leak is not detected.
- `measured` is `[]`, since counts do not vary between runs.
- What is judged, by form: statements and rows per request (pg_stat_statements); the statement log with its parameters (`log_statement`, for repeated reads, L10); plans (`auto_explain`, for sequential scans, L03); outbound attempts at the stub (L06, L07); pool and connection counts (L08, L13); the event loop's longest blocked stretch (L09); heap after a full collection, over a soak (L05); and the time of a fresh process's first request against its later ones (L11).
- Request templates: `$n` (the items at this scale), `$i` (an item's index inside `{ $repeat }`), `$list` (`1,2,...,n`, for ids in a query string) and, in a body, `$run` (the run's index, for values that must differ per run).
- A finding that agrees with a static finding (same check and rule; same method and route, or, for code no handler reaches, the symbol the trace names; and the statement that grows on one of its lines, except for Prisma, whose source holds a model call rather than SQL) is that static finding, with `trace` added to its `detection` and the counts added to its message. Its fingerprint, locations and fix stay the static finding's.
- A trace finding with no static match names its endpoint. It carries a guided fix when its statement or route is found in the source.

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | Every form as expected: each planted twin reports exactly its defects, linked where `trace.json` says, and each clean twin reports no error or warning |
| 1 | A form was not as expected, or its run was refused (a step over its caps) |
| 3 | Nothing failed, but in a timed form (trace: L09, L11; every load form) a planted defect was reported only as `timing unreliable`, so the form is not confirmed (`UNRELIABLE`, never `PASS`) |
| 2 | Cannot run: Docker is not running, PostgreSQL did not start, or the port is bound beyond 127.0.0.1 |
| 64 | Bad usage |
| 70 | Internal failure (`EX_SOFTWARE`): the harness, a judge (whose entry, like the CLI's, catches a module that fails to load), or a step outside them crashed (a fixture that answers wrongly, a container that does not start, a `raw.json` that cannot be read). Takes precedence over 1 and 3, since the run is incomplete. |
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

**Determinism.** The seeds use no randomness, and the counts are exact. For each of the four first forms, two consecutive runs gave reports identical apart from `started`, for both twins. L09's and L11's timings are judged under the relative timing rule (five runs or starts, every one clearing, none, or a mix), and L06's wait on the delay its code declares, which no machine changes. A planted defect that cannot be judged is reported as `UNRELIABLE ... timing unreliable`, with its samples, spread and load averages: neither missed nor passed, and the run exits 3 unless something else failed. Count-based forms never produce one.

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
| `heap-slope` | heap kept per request: the least-squares slope of the heap after full collections (about every 2 s) against responses answered, in each pair | L05 |
| `loop-max` | the event loop's longest stretch over the step (monitorEventLoopDelay), with a `background` | L09 |
| `attempts` | calls the stub received from one failing host, per request | L06 |
| `stub-open` | calls held open at a hanging host, at most | L07 |
| `failed` | share of requests that failed | L08 |
| `late-share` | share not answered within `okMs`; with a `background` (a second route at its own rate), the finding is about the background route | L09 |
| `max` | the slowest response, after a restart (`restart`) | L11 |
| `connections` | connections open at the database, at most | L13 |

A step's paths must start with a single `/` and resolve to the twin's own origin; anything else is refused.

**Judging.** Each twin against the other, never against an absolute number. A verdict on a count, or on a share with no time limit in it (`statements`, `rows`, `blocks`, `attempts`, `stub-open`, `connections`, `bytes`, `failed`), is exempt from timing rules: always judged, with the load averages recorded as information and `exempt: true` in `erlang.load.timing`. `heap-slope` is judged per pair under the relative timing rule: a pair clears when the twin's slope is positive, at least the step's floor, and at least its ratio times the other twin's in the same pair; the spread of the slopes and each fit's R² are recorded only. Every other load verdict (latencies, `loop-max`, `late-share`, the shedding gap) is relative and goes through the relative timing rule (above): five pairs in alternating twin order, each pair judged twin against twin at the step's ratio and floor; every pair clearing is a finding, none is no finding, a mix is `info`, `timing unreliable`. The load averages before and after each step (after: once the harness's own load has fallen, up to 120 s; docs/decisions.md, Q6) and the spread are recorded and gate nothing. A finding that agrees with a static finding (check, rule, and the symbol or endpoint) is that finding, with `load` in its `detection` and the measurements in `erlang.load`; its fingerprint stays the static finding's, and never holds a measured value.

**Expected misses.** A form's `expectedMisses` names planted defects below its measure's detection floor, each with the floor stated (L05's `createOrder`: a leak under about three times the clean twin's own retention). They stay in the fixture as the hard case: the planted twin need not report them and the run says whether it did; the clean twin must still report nothing there.

**Output.** `dist/load/<id>/<form>/raw.json` (every step of every repeat: counts of requests served in time, late, refused and failed, latency percentiles, the twin's probes, the load average before and after), the k6 scripts and summaries, and `<twin>/report.json`, a report/1.

**Exit codes**: as the trace harness's; 2 also when k6 is missing or a step is over its caps. A form passes only when the planted twin yields a failing finding for every defect and the clean twin reports no error or warning; a planted defect reported only as `timing unreliable` makes the form `UNRELIABLE`, printed with its samples, spread, load averages and why (for example `4 of 5 repeats cleared the threshold`), and the run exits 3 unless something else failed.

**Network and writes**: as the trace harness's. Load goes only to the twin, on 127.0.0.1.
