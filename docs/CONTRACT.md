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

A separate program, for ERLANG's own fixtures: `scripts/trace.sh` (`npm run trace`). It confirms static findings by counts, on a real database. It is not part of `erlang` or `npm test`. Design and decisions: `research/trace-harness.md`.

```
scripts/trace.sh [form ...]      e.g. scripts/trace.sh L01a-n-plus-one/sql
```

With no form, it runs every `fixtures/<id>/<form>/trace/trace.json`: today the `sql/` forms of L01a, L01b, L02 and L04.

**Inputs**

| Input | Needed | Notes |
|---|---|---|
| Docker | Yes | Runs `postgres:17.11@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f`, the image KERCKHOFFS pins. |
| A fixture form | Yes | Its twins, and `trace/`: `trace.json` (the requests or page views, and the expected defects), `seed.sql`, a schema (`schema.sql`, or the twins' own migrations), and `package-lock.json`. |
| Seed size | Fixed | Each form's `seed.sql`, at 1x and 10x. For example, L02 has 10,000 orders and events at 1x, and 100,000 at 10x. The seed is deterministic, and its SHA-256 is recorded. |
| URL | No | Each twin is started by the harness, on 127.0.0.1, on a port the system picks. |
| Test logins | No | The fixtures have no authentication. The database passwords are made for each run. |

**Output.** For each twin, in `dist/trace/<id>/<form>/<twin>/`:
- `raw.json`: every count;
- `report.json`: a report/1;
- `twin.log`: the twin's own log.

Trace findings are finding/1:
- `detection` includes `trace`.
- `erlang.trace` holds the counts at each scale, and the slope or ratio judged.
- `measured` is `[]`, since counts do not vary between runs.
- A finding that agrees with a static finding (same check, method and route, and the statement that grows is on one of its lines) is that static finding, with `trace` added to its `detection` and the counts added to its message. Its fingerprint, locations and fix stay the static finding's.
- A trace finding with no static match names its endpoint. It carries a guided fix when its statement or route is found in the source.

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | Every form as expected: each planted twin reports exactly its defects, linked where `trace.json` says, and each clean twin reports no error or warning |
| 1 | A form was not as expected, or its run failed |
| 2 | Cannot run: Docker is not running, PostgreSQL did not start, or the port is bound beyond 127.0.0.1 |
| 64 | Bad usage |
| 75 | ITTEN's inspector is running, so a timing run may be under way (`EX_TEMPFAIL`). Checked at start and before each twin. |

**Network**
- PostgreSQL publishes its port on 127.0.0.1 only. Each twin listens on 127.0.0.1 only. Requests go only to the twin, one at a time, at most 5 a second, three per request per scale.
- No load is generated.
- The first run pulls the image from Docker Hub, and installs each form's packages from the npm registry with `npm ci --ignore-scripts`, from its committed lockfile. Later runs reuse both.

**Writes**
- `dist/trace/`: results; installs, in `dist/trace/install/`; and the run's passwords, in a mode-700 directory, `dist/trace/run/<pid>/`, removed on exit.
- One Docker container, removed on exit, including on failure. The image stays in Docker's store.
- Nothing in `fixtures/`: each twin is copied to `dist/` before it runs.

**Determinism.** The seeds use no randomness, and the counts are exact. For each of the four forms, two consecutive runs gave reports identical apart from `started`, for both twins. Timings are written to the twin's log but never judged.

**Load on the machine.** Everything runs at `nice -n 15`. The container is held to one CPU and 1 GB. A full run of the four forms takes about 90 seconds.
