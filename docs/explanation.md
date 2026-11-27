# How Erlang works

This page explains why Erlang 0.1.0 is built the way it is. What each command, check, threshold and field is, is in the [reference](reference/README.md), and the full contract is in [CONTRACT.md](CONTRACT.md).

## Static on your code, measured on its own

The command reads source and configuration and runs nothing. It opens no socket and starts no process except `git` for `--version` ([CONTRACT.md](CONTRACT.md), Network). A check that ran your service would need your database, your data and your traffic, and a load test against a service that is not yours is a denial-of-service attack, so the only code Erlang ever runs is its own.

The static checks are tested against fixtures. Each defect class has a planted twin, where every defect is put in on purpose, and a clean twin, where each is fixed in place and nothing else differs. Decoys, code that looks like a defect and is not, sit in both twins, and reporting one counts as a false positive. The fixture suite scores every check on recall and precision this way (`fixtures/PLAN.md`).

Two harnesses then check that the static findings describe something real. The trace harness serves each twin against PostgreSQL in Docker and counts, one request at a time, what each request does: statements, rows, calls, bytes and connections. The load harness drives both twins with k6 at a fixed arrival rate and judges each against the other. There are <!--n:trace-forms-->19<!--/n--> trace forms and <!--n:load-forms-->14<!--/n--> load forms. Both harnesses start their twins on 127.0.0.1 and refuse any other target, so what they confirm is the checks' behaviour on Erlang's own code, and they support no claim about yours.

## Counts before clocks

A verdict that rests on a count, such as the statements a request sends, comes out the same on any machine, so it is judged as measured. Time depends on the machine, so a timed verdict is judged under rules that keep a slow or busy machine from changing it.

- **The relative timing rule.** A timed verdict compares two conditions measured together, such as the two twins of one pair, and needs at least <!--n:repeats-->5<!--/n--> repeats. It is a finding when every repeat clears the threshold, nothing when none does, and an info "timing unreliable" for a mix, which never fails a run. Pairs alternate which twin goes first, so a slowdown tied to order cannot favour one twin (docs/decisions.md, Q8).
- **Declared waits.** A fixed wait between retries is judged on the delay the code declares, recorded from the twin's timers, not on a clock, because nothing measured should enter a verdict about a value the code states.
- **A priming start.** Before the judged repeats of a timed form, each twin is started once and its figures are kept but not judged, so that a cold disk cache or a database's first sessions are not charged to the first repeat.
- **Medians and margins.** A shared CI runner can stall one sample with work that has nothing to do with the code, so the fixture suite judges margins on the median of the samples. A planted defect must clear its bar by twice, and a decoy must stay at most half way to its bar. A single sample past the judge's own bar still fails, because there the verdict itself would change.
- **Headroom.** At every load step's rate, the clean twin's main thread must be busy at most <!--n:headroom-max-->0.2<!--/n--> of the time, and two measurements over <!--n:headroom-one-->0.3<!--/n--> fail outright. Otherwise a verdict that compares the twins under load would turn on the machine's speed.

## The release gate

A commit is tagged only when its last <!--n:gate-runs-->5<!--/n--> CI runs are green and their trace reports are identical apart from what each finding lists as measured, as is a local trace on a second machine ([CONTRACT.md](CONTRACT.md), Release gate). Fingerprints carry no line number and no measured value, so the same finding has the same fingerprint in every run, and two reports can be compared without knowing any check. The gate exists because one green run can be luck: a verdict that holds on five runners and a second machine does not depend on any one of them.

## Choices that shape what it reads

- **Two database layers.** The checks read raw SQL through `pg` and Prisma. Scope was frozen at those two on 17 November 2026, so Drizzle is not read, and this is recorded so that a clean report is not taken to cover it (`fixtures/PLAN.md`, Known gaps).
- **Fixes suggested, never applied.** Every finding carries a fix, either complete edits or the places to change with a note. Applying one is the caller's step, and every automatic fix in the fixtures is applied and re-checked by the test suite.
- **k6 kept apart.** k6 is under AGPL-3.0, so Erlang runs the `k6` that the user or CI installed as a separate program and never bundles it (`research/load-harness.md`). CI installs k6 <!--n:k6-->v2.3.0<!--/n-->, checked by its SHA-256.
- **A shared format.** Findings and reports follow finding/1 and report/1, shared with Itten and Kerckhoffs. Erlang keeps a pinned copy of the shared code in `core/`, and a test fails if any copied file changes, so the format is changed where it is shared and copied again.
- **Rules with sources.** Each finding names rules from `reference/`, which holds <!--n:rules-->70<!--/n--> rules in <!--n:rule-files-->7<!--/n--> files, each with its sources. Erlang has <!--n:checks-->15<!--/n--> checks, which cover some of them.
