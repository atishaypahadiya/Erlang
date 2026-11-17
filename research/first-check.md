# The first check: a proposal

Proposed and reviewed on 17 November 2026; the decisions are at the end. Check A is being built.

The owner's machine is busy with a science run for days, so ERLANG's first check must be static: it reads source and configuration and generates no load. Its findings carry `detection: ["static"]`, or `["config"]` where configuration alone decides. Checks that need trace or load evidence come later, on GitHub's runners or once the machine is free. Stack as decided: Node 22 and TypeScript or JavaScript first, with raw `pg` and Prisma.

Prior-art claims below were checked against raw source text (code, docs source, release notes) on 17 November 2026; sources C1–C18 are at the end. "None found" means a search of npm, GitHub code search, the public Semgrep rules and the CodeQL repository found nothing mainstream. It does not prove that nothing exists: Semgrep's Pro rules are not public.

## Candidates

Each candidate comes from the failure model (`research/failure-model.md`) and the planned fixtures (`fixtures/PLAN.md`), and is listed with the rules it checks.

### A. `no-timeout`: outbound calls without a deadline (TMO-01, TMO-02; fixture L07)

**What it reports.** A request handler calls another service or the database with nothing that bounds how long it waits.

**What the libraries do by default**, which decides what counts as "no timeout":

| Client | Default | Source |
|---|---|---|
| `fetch` (Node's undici) | No overall deadline. `headersTimeout` and `bodyTimeout` are 300 s each, and the body timer resets on every chunk, so a slow trickle never ends. undici rejects an overall `requestTimeout`; only `signal` (`AbortSignal.timeout`) gives a deadline. | C4 |
| axios | `timeout: 0`: "If set to 0 (default) a timeout is not created." | C5 |
| got | "By default, there is no timeout set." | C11 |
| `pg` | Pool `connectionTimeoutMillis` 0 ("no timeout"); `statement_timeout` and `query_timeout` "default is no timeout". Pool `max` 10. | C6 |
| Prisma 6 | `pool_timeout` 10 s, `connect_timeout` 5 s; no per-query timeout. | C7 |
| Prisma 7 with the `pg` adapter | Pooling "now come[s] from the driver itself": `max` 10, acquire timeout `connectionTimeoutMillis` 0. No per-query timeout. | C7 |

**Prior art.** Python is covered several times over:
- Bandit B113 (C1);
- Ruff S113 (C2);
- Pylint W3101 `missing-timeout` (C3);
- Semgrep's `use-timeout` rule (P22).

All four cover `requests` and skip `Session` calls by default. Bandit and Ruff flag httpx only for an explicit `timeout=None`, because httpx has a default.

For JS/TS, none mainstream was found. What exists:
- an ESLint plugin for LLM SDK calls (51 downloads a week);
- unpublished in-repository rules in two projects (C8).

There is no CodeQL JS query, and no public Semgrep JS rule.

**The gap.** JS/TS outbound HTTP, and database clients in any language.

**Precision plan.**
- Resolve the client from its import: `fetch`, `axios` and instances made by `axios.create`, `got` and `got.extend`, `node:http`/`https`, `pg` `Pool`/`Client`, Prisma Client.
- Accept every form of deadline:
  - `signal` built from `AbortSignal.timeout` or `AbortSignal.any`;
  - axios `timeout` on the call, the instance or `axios.defaults`;
  - got `timeout.request`;
  - `pg` `statement_timeout`/`query_timeout` in the pool config or the connection string;
  - `SET statement_timeout` in a migration or the pool's `connect` hook;
  - for Prisma, a `$transaction` timeout or the adapter's own pool options.
- An options object the check cannot resolve (a spread, an import from a module it cannot follow) gives `info` with `unresolved: true`, never an error. The two unpublished JS rules make the same choice, and it is what separates high precision from high recall.
- `fetch` with no signal is an error. The 300 s idle timers do not bound total time.
- Scope (decided, below): every outbound call in the scanned files is checked, with no handler detection. Paths that are not part of the app (scripts, tests) are excluded in `erlang.config.json`.
- TMO-02 (the timeout covers the whole call) is a second pattern: an axios `timeout` or got `timeout.response` with no `signal`, on a streamed body, is `warning`.

### B. `retry-policy`: retries with no backoff, no jitter or no cap (RTY-01, RTY-03, RTY-04, RTY-06; fixture L06)

**What the libraries do by default:**

| Library | Default | Source |
|---|---|---|
| axios-retry | 3 retries, `retryDelay: noDelay`: "By default there is no delay between retries." `exponentialDelay` adds 0–20% jitter; `linearDelay` adds none. | C9 |
| p-retry | 10 retries, `factor` 2, `randomize: false`: exponential, no jitter, `maxTimeout` Infinity. | C10 |
| got | `limit: 2`, `noise: 100`: 0–100 ms of jitter on 1 s, 2 s, 4 s steps, with no cap on the backoff. | C11 |

**Prior art.** No CodeQL query and no public Semgrep rule for backoff or jitter were found. One small ESLint plugin checks jitter for Effect's `Schedule` only (8 stars). Two rules check for a missing attempt limit, not for backoff (C12). Datadog's APM recommendations cover retries at runtime (P16).

**The gap.** Static, before merge, and for the common libraries' defaults.

**Precision plan.**
- Start with library configuration, which is exact: report the resolved policy (attempts, delays, jitter, which statuses are retried), not just "has backoff".
- Hand-written retry loops (a `catch` inside a loop that calls the same outbound function again) come second. They are harder: ESLint's own docs tell people not to use `no-await-in-loop` on retry loops (C14), because the shape alone says nothing.
- Retrying on 429 or 503 is RTY-06, a separate pattern.

### C. `unbounded-query`: list reads with no limit (STB-04, DAT-04; fixture L02)

**What it reports.** A Prisma `findMany` with no `take`, a Drizzle `select` with no `.limit()`, or a raw `SELECT` with no `LIMIT`, whose rows go back to a request. Also a page size taken from the client without a cap.

**Prior art.**
- Static, for JS/TS: none found.
  - eslint-plugin-prisma (3,276 downloads a week) has `require-select`, about which columns, not how many rows.
  - eslint-plugin-drizzle has only the delete-and-update-with-`where` rules.
- Runtime, Prisma 8 (a release candidate): opt-in `lints` middleware that warns on "a SELECT with no LIMIT", and `budgets`, which "rejects any `SELECT` … that has no `LIMIT` on it, however few rows the table holds" (C16).

**The gap.** Before merge; Prisma 6 and 7, Drizzle and raw SQL; and the client-chosen page size.

**Precision plan.** Don't report:
- a read bounded by its key (a `where` on `@id` or `@unique`, read from the Prisma schema or migrations);
- aggregates;
- reads that are streamed or cursored.

Small lookup tables are the hard case: static code cannot know a table's size. Report them as `warning`, not `error`, unless the rows are serialized into the response. A project can name its small tables in configuration.

### D. `n-plus-one` and `per-row-writes`: one query per item (DAT-01, DAT-02; fixtures L01a, L01b)

**What it reports.** A query (a read for L01a, a write for L01b) inside a loop over another query's result or over request input.

**Prior art.**
- Runtime: Sentry, Datadog, New Relic and Scout all detect N+1 from traces (P16–P20).
- Static: none found for JS/TS.
  - The nearest is CodeQL's experimental Go query "Database call in loop", for GORM (C16).
  - In research, Chen et al. detected ORM anti-patterns statically in Java (S31 in `reference/SOURCES.md`).
  - ESLint's `no-await-in-loop` is generic, unaware of databases, and not in `eslint:recommended` (C14).

**The gap.** Rank 1 in the failure model, and no static check for JS/TS.

**Precision plan.**
- Know the ORM's batching, by version:
  - Prisma 6 and 7 batch `findUnique` calls made in the same tick (C13). So `Promise.all(ids.map(id => prisma.x.findUnique(...)))` is one query, and a sequential `await` in a `for` loop is not. The docs state the same-tick rule but name neither case; both follow from the dataloader source, which dispatches on `process.nextTick`. The fixture must confirm them before the check relies on them.
  - Batching applies only to `findUnique` with scalar equality filters.
  - Probed on 17 November 2026 (`research/prisma-batching.md`): both cases are confirmed; `findUnique` batches even with a non-unique filter added, so the scalar-equality limit above does not hold; `findFirst`, `findMany`, `count` and every write are never batched.
  - Prisma 8 drops it (C13). The check must read the resolved Prisma version from the lockfile.
- Report only when the loop's bound comes from a query result or request input. A loop over a literal array or a fixed small list is the decoy in `fixtures/PLAN.md`.
- Static sees the shape, not the size, so the message says so. A trace check later confirms the count.

### E. `pool-sizing`: pool size × instances against the database's limit (CAP-08, CAP-10, OVL-11; new config fixture)

**What it reports.** Pool `max` × instances × workers per instance exceeds the database's connection limit.

**The inputs:**
- Pool size: `pg` default 10 (C6); Prisma 6 default `num_physical_cpus * 2 + 1`; Prisma 7 with `pg`, 10 (C7).
- Instance count: `fly.toml`, Kubernetes `replicas` or HPA `maxReplicas`, Compose `replicas`, PM2 `instances`, or a serverless platform (unbounded concurrency).
- The database's limit: PostgreSQL's `max_connections` is "typically 100" (C17).

**Prior art.** None found, only documentation. Prisma 6 advises `connection_limit` 1 to start with on serverless; Prisma 7 keeps the warning but drops the 1 (C18).

**The gap.** Everything.

**Precision plan.**
- Report only when every factor is known. When the database's limit is unknown (common with managed databases), the finding is `info` and `unresolved`.
- Low recall, but a finding is nearly always right.
- PLAN's L08 is a leaked connection, a different defect, so this needs a new fixture.

### Not first

- `blocking-work` (`*Sync` in a handler; L09). eslint-plugin-n's `no-sync` already flags `*Sync` calls, though it is off by default and not limited to handlers (C15). The gap is narrow.
- `memory-growth` (L05) and `no-cache` (L10) are weak statically, as PLAN says.

## Recommendation

**First `no-timeout` (A), then `n-plus-one` with `per-row-writes` (D), then `unbounded-query` (C).** B and E follow.

Why A first:
- It has the clearest gap: four tools cover Python and none mainstream covers JS/TS.
- It enforces a MUST rule.
- It is deterministic, and its fixture is small.
- Its precision levers are known.
- It runs the whole pipeline end to end: the pinned core, report/1, the fixture scorer and decoys.

D has the highest value, rank 1 in the failure model, but its precision depends on per-version ORM behaviour (Prisma's batching, and Prisma 8 changing it), so it goes second, on a pipeline that already works.

## Shared core, pinned

ERLANG uses KERCKHOFFS's `core/` as a pinned, read-only copy until the shared core is extracted into its own repository:
- `finding.js`;
- `report.js`;
- `fixture-score.js`;
- `schema.js`;
- `schema/finding.schema.json` and `schema/report.schema.json`.

About the copy:
- **Pinned commit:** the files are copied from KERCKHOFFS at `0f70ed0`, the last commit to touch `core/`. That `core/` is itself a pinned copy of ITTEN's released contract at `v0.3.5` (`f79c18f`).
- **No dependencies:** it imports only `node:fs` and `node:path`.
- **Read-only:** the files are copied from the security tool in the same set, at its commit 0f70ed0 (`git show 0f70ed0:core/<file>`), with nothing written in KERCKHOFFS. The SHA-256 of each file is recorded, and a test fails if any of them changes.
- **Temporary:** `core/README.md` will say so, and will name the source commit.

The released finding/1 already answers most of `research/finding1-requirements.md`:
- `where` takes `locations`, `endpoints` and `resources` together;
- `rules` is in the core;
- `detection` (`render`, `static`, `config`, `trace`, `live`, `load`) is the evidence field ERLANG asked for.

That file needs a note that it is superseded where the release settled a question.

## Questions

1. **First check.** `no-timeout` first, as recommended, or `n-plus-one` first, as PLAN's build order (L01a first) implies?
2. **Parser.** KERCKHOFFS has no dependencies and lexes SQL by hand. ERLANG's checks need loops, call targets and option objects in JS/TS, which a hand lexer cannot give reliably. Options:
   - the TypeScript compiler API (`typescript`, Apache-2.0): parses JS and TS, and can resolve a call to its import or instance;
   - a plain parser such as acorn (MIT, JS only, TS stripped first);
   - stay dependency-free and handle only the simple shapes.

   Recommendation: `typescript`, as the one runtime dependency.
3. **Pinned core.** Copy into ERLANG's `core/` from KERCKHOFFS `0f70ed0`, with recorded hashes and a test, as above?
4. **Prisma version for fixtures.** npm's `latest` for the `prisma` CLI is now `8.0.0-rc.34`, while `@prisma/client` is at `7.10.1`. Pin fixtures to Prisma 7.10.1 and add a Prisma 8 form once 8 is released? The batching difference makes it a real second form for D, not a copy.
5. **Scope of "request path".** A, C and D report only code reachable from a request handler. Should ERLANG find handlers itself (Express, Fastify, `node:http`, Next.js route files), or take entry points from a project configuration file, as KERCKHOFFS takes its excludes?

## Decisions

Taken on review, 17 November 2026.

1. **Order.** `no-timeout` (A) first, then `n-plus-one` with `per-row-writes` (D), then `unbounded-query` (C).
2. **Parser.** TypeScript, pinned, as the sole runtime dependency, with its type checker resolving clients across modules (instances made by `axios.create`, fetch wrapped in a helper). Options it cannot resolve give `info`, never `error`. The pin is `typescript@6.0.3`: npm's `latest`, 7.0.2, is the native compiler, whose package exports only a version stub and an `unstable/` API, with no `createProgram` or type checker. 6.0.3 is the last release of the JavaScript compiler, and it resolves an `axios.create` instance across modules without the project's dependencies installed (tried on 17 November 2026).
3. **Shared core.** A read-only copy of KERCKHOFFS's `core/` from its `main` at `e1eeb00`, with the SHA and each file's SHA-256 recorded, a test that fails if a copied file changes, and a note that it is temporary. `core/` there has not changed since `0f70ed0`. KERCKHOFFS's ground rules are adopted from the start:
   - a fix in every finding, `auto` or `guided`, with the fix re-check test;
   - per-file isolation, where an error makes the report partial (exit 3 without findings);
   - scan excludes, with a self-scan in `npm test` that must come back clean;
   - exit codes 0, 1, 2, 3 and 64.

   See `fixtures/PLAN.md`.
4. **Prisma.** Fixtures pin Prisma 7.10.1. Prisma 8 forms come only after 8.0 is generally available.
5. **Handlers.** Not needed for A, which checks every outbound call in scope. For D: detect Express, Fastify, `node:http` and Next.js route handlers, and let a project override them in a brief.

## Sources

Checked against raw text on 17 November 2026. P- and S- numbers refer to `research/prior-art.md` and `reference/SOURCES.md`.

| ID | Source |
|---|---|
| C1 | Bandit 1.9.4, `bandit/plugins/request_without_timeout.py` (B113). https://github.com/PyCQA/bandit/blob/1.9.4/bandit/plugins/request_without_timeout.py |
| C2 | Ruff, "request-without-timeout (S113)". https://docs.astral.sh/ruff/rules/request-without-timeout/ |
| C3 | Pylint, `pylint/checkers/method_args.py` (W3101 `missing-timeout`); "What's new in Pylint 2.15". https://github.com/pylint-dev/pylint |
| C4 | undici, `lib/dispatcher/client.js` and `docs/docs/api/Client.md` (6.29.1 as in Node 22; 7.30.2; 8.12.4). https://github.com/nodejs/undici |
| C5 | axios v1.21.1, `lib/defaults/index.js`. https://github.com/axios/axios |
| C6 | node-postgres, `docs/pages/apis/pool.mdx`, `client.mdx`, `packages/pg/lib/defaults.js` (pg 8.23.1, pg-pool 3.14.0). https://github.com/brianc/node-postgres |
| C7 | Prisma docs, connection pool, v6 and v7. https://github.com/prisma/docs |
| C8 | Searches for JS/TS timeout rules: npm search, GitHub code search, semgrep/semgrep-rules, github/codeql. Found: eslint-plugin-llm-app `require-timeout`; in-repository rules in github/gh-aw and langwatch/langwatch. |
| C9 | axios-retry 4.5.0, `src/index.ts`, README. https://github.com/softonic/axios-retry |
| C10 | p-retry 9.0.0, `readme.md`, `index.js`. https://github.com/sindresorhus/p-retry |
| C11 | got 16.2.0, `documentation/7-retry.md`, `documentation/6-timeout.md`, `source/core/calculate-retry-delay.ts`. https://github.com/sindresorhus/got |
| C12 | Searches for backoff and jitter rules, as C8. |
| C13 | Prisma docs, query optimization, v6 and v7; `packages/client/src/runtime/DataLoader.ts` at 7.10.1; Prisma 8 "Coming from Prisma ORM 7". https://github.com/prisma/docs, https://github.com/prisma/prisma |
| C14 | ESLint 10.15.0, `no-await-in-loop` docs and rule source. https://github.com/eslint/eslint |
| C15 | eslint-plugin-n 18.5.0, `no-sync`. https://github.com/eslint-community/eslint-plugin-n |
| C16 | eslint-plugin-prisma and eslint-plugin-drizzle on npm; CodeQL `go/ql/src/experimental/CWE-400/DatabaseCallInLoop.ql`; Prisma docs `llms-full.txt` (Prisma 8 `budgets`, `LINT.NO_LIMIT`). |
| C17 | PostgreSQL 17, "Connections and Authentication", `max_connections`. https://www.postgresql.org/docs/17/runtime-config-connection.html |
| C18 | Prisma docs, databases and connections, v6 and v7. https://github.com/prisma/docs |
