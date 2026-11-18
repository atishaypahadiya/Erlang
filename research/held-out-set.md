# A held-out set for ERLANG's checks: a proposal

Status: proposal, 17 November 2026. Nothing is built. The decisions it needs from the owner are at the end.

The fixtures are written by whoever writes the checks. They show that each check finds what it was built to find, not that it finds what real services get wrong: the planted forms and the check's patterns come from the same head. Today every check scores recall and precision 1.00 on its fixtures, and that number says little about the wild.

A held-out set measures the rest. Its definition is ITTEN's (ROADMAP, "held-out defect set"), so the three specialists mean the same thing by it:
- real bugs, each with the commit before its fix and the commit after;
- defects planted blind, without access to the checks;
- scored and published apart from the fixtures, never merged with their numbers;
- never used to tune a check.

## Two parts

### Real fixes from public Node repositories

Each case is a public commit that fixes one of ERLANG's defect classes, with its parent:
- **before**: the parent commit, which has the defect;
- **after**: the fix commit, which does not.

**What qualifies**
- JavaScript or TypeScript, server-side Node code: a request handler in Express, Fastify, `node:http`, Next.js route handlers, or another framework (see strata, below).
- The fix is focused. The commit or its pull request says what it fixes, and the diff shows it: a query moved out of a loop, a `LIMIT` added, a release moved into `finally`, a `*Sync` call replaced, a timeout added. A refactor that fixes the defect along with twenty other things is skipped, since its "after" cannot be trusted to differ only there.
- The defect maps to one of the classes in `research/failure-model.md`.
- Any licence. Cases are stored by reference: repository, the two SHAs, the files and lines. No third-party code is committed anywhere.

**Two strata, reported apart**
- **In scope**: frameworks and clients ERLANG claims to read (`docs/CONTRACT.md`, Scope and limits), such as `pg` and Prisma for the data checks. Recall here measures the checks.
- **Out of scope**: the same defect classes through code ERLANG says it does not read, such as Drizzle, Knex, mysql2, Koa or NestJS. Recall here measures coverage of the wild, and is expected to be low. Recording it keeps the known gaps honest in numbers, not only in prose.

**Agent-written code.** ERLANG's failure model is about services written by coding agents. Where a repository or commit declares agent authorship (a trailer, a bot account, a statement in the README), the case is tagged, and results are also given for that tag. Undeclared authorship is not guessed.

**How cases are found.** GitHub search over merged pull requests in JavaScript and TypeScript repositories, with narrow queries per class, then screening by hand.

**The pilot**
- **Searches.** On 17 November 2026, a few searches checked that the cases exist.
- **What the counts show.** The counts for broad queries mean nothing. GitHub tokenises `"n+1"` loosely, and "add index" matches every `index.js`. Narrow queries did better: `"connection leak" in:title`, merged, JavaScript or TypeScript, gives about 700, and `pbkdf2Sync` gives about 450.
- **Sampled titles.** In 15 titles from each of three narrow queries, about a third looked like real candidates by title alone. Examples: a database connection leak fixed in an indexer, passwords hashed off the event loop, an N+1 fixed in a timeline endpoint. The rest were unrelated, or their changes sat in another language.
- **Limits.** GitHub's language filter is the repository's main language, not the diff's, so every case must be screened at the diff.
- **What this establishes.** Cases exist for at least `pool-exhaustion`, `blocking-work` and `n-plus-one`; how many qualify per class is unknown until screened.
- **Exclusions.** Those 45 results, from 42 repositories, were seen while the checks were developed. They are excluded from the set (decision 2). The list is kept outside ERLANG's repository, at `dist/held-out/pilot-seen.txt` until the set's home exists, so strangers' repositories are not named in ERLANG's docs.

**Existing datasets.** The studies behind the failure model are of Rails applications, Java ORMs and general software (`research/failure-model.md`, F1 to F3). None gives Node cases, so ERLANG mines its own.

### Blind planting

Defects are planted blind, without access to the checks. Planting works from:
- the rules (`reference/`);
- the defect classes, in plain words, from the failure model's ranking (names and descriptions only, not its "Cheapest reliable detection" column);
- the stacks in scope;
- this protocol;
- the format of the answer key.

Planting has no access to:
- `checks/`, `lib/`, `fixtures/`, `fixtures/PLAN.md`, or the README's check list, all of which describe what the checks recognise;
- any finding, score or miss from earlier rounds.

Defects are planted into two kinds of host:
- **Services written for the set**, from a short spec (a shop, a booking API, an accounts service), of the kind ERLANG targets. Each service is written clean, then planted. Both versions are kept, so each defect has a before and after of its own.
- **The "after" commits of real cases**, so planted defects sit in real code with real structure.

For each defect, the answer key records:
- the file, line and enclosing function;
- the defect class and the rule it breaks;
- one sentence on why it is a defect.

**Decoys** are planted too: correct code that resembles a defect, such as a loop over a fixed list of three, a sync read at startup, or a release in a helper that owns it. A finding on a decoy counts against precision. The forms vary the way real code varies, without aiming for or away from any detector, which is out of view.

**Sealing**
- The key is written outside ERLANG's repository.
- Its SHA-256 is recorded in the set's manifest before ERLANG first runs on the cases.
- The key is opened only for scoring.

## Scoring

**Recall.** A real case is caught when a finding of the mapped check has a location:
- inside the lines the fix changed in the before commit, or
- in the function that encloses them.

Real fixes have no single defect line, so this is looser than the fixtures' file, line, column and symbol. Planted cases use the key's file and function. Severity is reported but not required to match.

**Precision**
- **Planted cases:** every finding on the clean version, and every finding on a decoy, is a false positive.
- **Real cases.** ITTEN counts any finding on the "after" page against precision. For a repository that is too strict: an after commit can hold other real N+1s that the fix never touched. Instead:
  - A finding in a file or function the fix changed counts against precision.
  - A finding elsewhere in the after commit is recorded, then judged real or false by the owner, and published as its own count (decision 4).

**Numbers.** Results are published per check:
- n, recall and precision, each with a 95% Wilson interval, since n will be small;
- in-scope and out-of-scope recall, apart;
- real and planted results, apart, and never merged with the fixtures' 1.00.

**Freezing**
- Each scoring run records ERLANG's commit from `--version`, which must show no uncommitted changes.
- It also records the manifest's SHA-256 and the key's.
- Scoring runs happen at releases, not during development, so the set is looked at rarely.

## Keeping it held out

- **Where it lives.** In a private repository of the owner's, not in ERLANG's. The checks are developed without access to the held-out set; read access to it is denied by configuration. ERLANG's repository receives only the published numbers, and per-case results by id and class, with no code and no locations.
- **Curation.** Real cases are screened and defects planted without access to ERLANG's checks, as above. Nothing done with access to the checks screens cases or plants defects.
- **Burning.** A check is not changed to pass a held-out case. When a miss shows a real gap:
  - the gap is recorded under Known gaps, by class;
  - any fix is driven by a new fixture, written from the class, not from the case;
  - the case is burned: moved to a seen list, and left out of later held-out scores.
  The set is topped up to keep its size.
- **Seen repositories.** A repository seen while the checks were developed, including the pilot's 42, is never a case.

## Running it safely

- **Static only.** `erlang` reads the before and after trees. Nothing from a third-party repository is installed or run, since install scripts and code are untrusted.
- **Fetching.**
  - Each case is fetched read-only from GitHub at its pinned SHAs, into the held-out repository's own output folder.
  - The SHA-256 of each tree is recorded.
  - A case whose commits disappear upstream is retired and listed, not replaced silently.
- **No traffic.** No load, no trace, and no request to any service of the repositories' owners. The trace harness could later run the planted services written for the set, which are the owner's own code, but not third-party ones.

## First round

**Real cases.** Five per built check, in scope, plus whatever out-of-scope cases turn up while screening. The built checks are `no-timeout`, `n-plus-one`, `per-row-writes`, `unbounded-query`, `missing-index`, `retry-policy`, `pool-sizing`, `pool-exhaustion` and `blocking-work`.
- `pool-sizing` needs deployment files beside the code, so its cases may be scarce. If fewer than five qualify, the shortfall is reported, not filled.

**Planted cases.**
- Five defects and three decoys per built check.
- Across three or four services written for the set.
- Some are planted into after commits.

**Size and growth.**
- That is about 45 real and 45 planted defects.
- Grow to 15 of each per check before ERLANG 1.0.

**Unbuilt classes.** Collect cases now for the classes with no check yet: L04 payloads, L05 memory, L10 caching, L11 cold starts and L12 load shedding. Cases collected before a check exists are as held out as it gets.

## Decisions

1. **Home.** A private repository of the owner's, outside ERLANG, with read access to it denied by configuration wherever the checks are developed (recommended). Or a private folder inside ERLANG's repository, gitignored, which is simpler but easier to leak into the checks' development.
2. **Curation.** Screening and planting are done in isolation from the checks, and a sample is spot-checked by the owner (recommended). Or curation by hand.
3. **Size of the first round.** 5 real and 5 planted per built check (recommended), or more.
4. **Precision on real after-commits.** Scoped to what the fix changed, with the rest judged by the owner and reported apart (recommended). Or ITTEN's rule, where any finding on the after commit counts.
5. **Out-of-scope stratum.** Collected and reported apart (recommended), or left out.
6. **Unbuilt classes.** Collected now, before their checks exist (recommended), or later.
7. **Cadence.** Scored at releases only (recommended), or on demand.
