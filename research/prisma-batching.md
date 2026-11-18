# Prisma 7.10.1: which access patterns send one statement per item

Observed on 17 November 2026 with `research/probes/prisma7-batching/` (`run.sh`). The `n-plus-one` and `per-row-writes` checks are built on these observations, not on the docs or the source alone.

## How it was run

- Prisma 7.10.1 (`prisma`, `@prisma/client`, `@prisma/adapter-better-sqlite3`), better-sqlite3 12.11.1, versions pinned in the probe's `package-lock.json`.
- Both of Prisma 7's generators: `prisma-client-js`, and `prisma-client` (its TypeScript run with Node's type stripping).
- Node 25.5.0 and Node 22.23.5, each with its own install.
- SQLite, a file under `dist/`. Ten customers, each with one order.
- Each case starts a fresh log and counts the statements in Prisma's `query` log, leaving out transaction control (`BEGIN`, `COMMIT`). No load: ten items and at most a few dozen statements per case.

All four runs (two generators, two Node versions) gave the same counts and the same statement shapes in all 27 cases.

## Results

Ten items per case. "1" means one statement for all ten; "10" means one per item.

### Reads

| Case | Statements |
|---|---|
| `await findUnique` by id, in a `for` loop | 10 |
| `Promise.all` of `findUnique` by id | 1 (`WHERE id IN (…)`) |
| `Promise.all` of `findUnique` by a `@unique` field (`email`) | 1 |
| `Promise.all` of `findUniqueOrThrow` by id | 1 |
| `Promise.all` of `findUnique` by id, plus a non-unique filter (`name`) | 1 (an `OR` of `id = ? AND name = ?`) |
| `Promise.all` of `findUnique` by id, the same `include` on each | 2 (one per table) |
| `Promise.all` of `findUnique` by id, two different `select`s | 2 (one per `select`) |
| `Promise.all` of `findFirst` by id | 10 |
| `Promise.all` of `findMany` by id | 10 |
| `Promise.all` of `count` | 10 |
| `Promise.all` of async callbacks that `await findUnique` | 1 |
| … that first `await` something that is not a query | 1 |
| … that first `await` another `findUnique` | 2 (each batched) |
| `findUnique` promises pushed in a `for` loop, then `Promise.all` | 1 |
| `findUnique` promises pushed in a `forEach`, then `Promise.all` | 1 |
| `Promise.all` of the fluent `order.findUnique(…).customer()` | 2 |
| `findMany`, then each order's customer with `await findUnique` in a `for` loop | 11 |
| `findMany`, then each order's customer with `findUnique` in `Promise.all` | 2 |
| `findMany` with `include: { customer: true }` | 2 |
| `Promise.all` of `findUnique` inside an interactive `$transaction` | 1 |
| `findUnique` calls in a batch `$transaction([…])` | 1 |

### Writes

| Case | Statements |
|---|---|
| `await create` in a `for` loop | 10 |
| `Promise.all` of `create` | 10 |
| `create` calls in a batch `$transaction([…])` | 10 (in one transaction) |
| `createMany` | 1 (a multi-row `INSERT`) |
| `await update` in a `for` loop | 10 |
| `updateMany` | 1 |

## What this confirms, corrects and adds

- **Confirmed:** a sequential `await` of `findUnique` in a loop is not batched, one statement per item. The docs did not say this; it was inferred from the dataloader source (`research/first-check.md`, C13).
- **Confirmed:** `findUnique` and `findUniqueOrThrow` started in the same tick are batched into one `IN` query per model and per `select`/`include` shape. This holds whether they are started from `Promise.all(map)`, a `for` loop that collects promises, or `forEach`, and inside either kind of transaction.
- **Corrected:** batching is not limited to scalar equality filters on the unique field. A `findUnique` with an extra non-unique filter was still one statement. The check does not need to read the `where` clause to decide.
- **Added:** `findFirst`, `findMany` and `count` are never batched, even started together in `Promise.all`. One statement per item.
- **Added:** writes are never batched, even inside a batch `$transaction([…])`. Only `createMany` and `updateMany` write many rows in one statement.
- **Added:** an `async` callback that awaits before its `findUnique` still batches with its siblings. The awaits resolve in the same order across items, so the queries are started together again. A chain of two queries per item costs one statement per step, not one per item.

## What the checks do with it

- `n-plus-one` (DAT-01): a Prisma read started once per item in a loop or a per-item callback is reported, except a `findUnique` or `findUniqueOrThrow` whose calls are started together (not awaited one at a time), which Prisma 7 sends as one statement. A sequential `await` of any read in a loop is reported. Raw SQL through `pg` has no batching, so a query once per item is reported in every form.
- `per-row-writes` (DAT-02): a Prisma `create`, `update`, `upsert` or `delete` once per item is reported in every form, including `Promise.all` and a batch `$transaction([…])`; the fix is `createMany` or `updateMany`. Raw SQL `INSERT` or `UPDATE` once per item is reported the same way.
- The rules hold for Prisma 6 and 7. Prisma 8 drops the batching (C13), so with Prisma 8 resolved from the lockfile every per-item `findUnique` is reported. Nothing here was run against Prisma 8, and Prisma 6 was not run either.

## Not covered

- PostgreSQL. SQLite was enough to count statements: the batching happens in Prisma's client before the driver adapter. A PostgreSQL run would only change the SQL dialect in the shapes.
- Drizzle: out of scope (scope frozen; `fixtures/PLAN.md`, Known gaps).
- `upsert`, `delete` and `deleteMany` were not run. They are treated as `update` and `updateMany`.
