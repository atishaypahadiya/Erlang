# Decisions

Decisions cited by `docs/CONTRACT.md` and by the code, numbered as they are cited (Q2 to Q6 and Q8). Each records what was decided, when, and the evidence it rests on.

## Q2. Timing judgements in the trace harness

**Decided, 19 November 2026.** Timing judgements follow the shared timing rule. Erlang takes no lock of its own and honours ITTEN's timing lock, which replaces the check for ITTEN's inspector process: `lib/itten-lock.js`, used by `scripts/trace.sh`, `scripts/trace/run.js` and the load harness; `research/itten-lock.md` states the rule.

**Context.** The trace harness was designed with no timing judgement (`research/trace-harness.md`), since latency on a shared machine is not deterministic. Some trace cells in `fixtures/PLAN.md` are timings all the same: L09's event-loop delay, L11's first-request latency, and L06's fixed wait between retries, which shows only as gaps that are all alike. Count-based judgements stay count-based. Since superseded for relative verdicts by Q8, and for L06's wait by the rule for absolute waits (`docs/CONTRACT.md`, Timings).

## Q3. L12's trace cell needs concurrency

**Decided, 19 November 2026.** L12's trace cell is covered by its load cell, and `fixtures/PLAN.md` says so.

**Context.** L12's trace cell is "queue time rising with load". The trace harness sends one request at a time by design (no load, no concurrency), so a queue never forms there. The load harness measures queue time against offered load for L12. A few concurrent requests in the trace harness would be load by another name.

## Q4. bcryptjs's asynchronous forms still hold the event loop (L09)

**Decided, 19 November 2026.** L09's clean twin hashes off the main thread (`crypto.scrypt`). `blocking-work` reports bcryptjs at cost 10 or more, sync or async, with a guided fix only, whose note gives a migration path for existing hashes (verify with the old hash, re-hash on the next login). Measured milliseconds stay out of the fingerprint.

**Context.** OVL-12 asks for the asynchronous forms "which run on the worker pool". bcryptjs 3.0.3 is pure JavaScript: its asynchronous `hash` and `compare` run on the main thread in slices of up to 100 ms, yielding with `setImmediate` between them. The L09 trace measured it at cost 12: the clean twin's `POST /login` (`await bcrypt.compare`) held the loop for about 203 ms of a 223 ms request, against 229 ms for the planted `compareSync`. Either way the main thread does all of the hashing work, so under load the asynchronous form serves no more logins than the synchronous one. Keeping it as clean would contradict OVL-12's own wording and the measurement.

## Q5. A lock in another format

**Decided, 19 November 2026.** A lock in a format Erlang does not know counts as active, as an unparseable one does; it is stale only when its pid is dead or its expiry past: `judgeLock` in `lib/itten-lock.js`, its unit case, `research/itten-lock.md`.

**Context.** The timing-lock rule makes a lock active when "the file parses, the format matches, the pid is alive and now is before expires", and a file that cannot be read or parsed active too. A file that parses in another format (a future `itten-timing-lock/2`), with a live pid and a future expiry, was neither active nor stale under that wording. Failing closed keeps a newer ITTEN from being timed under load before Erlang learns its format.

## Q6. The timing rule's "after" reading in a load run

**Decided, 19 November 2026.** No load verdict depends on the load average any more: counts and shares are exempt, the heap slope is judged per pair, and timed relative verdicts follow the relative timing rule (Q8), which records the load average only. The harness still reads "after" once its own load has stopped, and records it.

**Context.** The timing rule counted a timing only when the one-minute load average was below half the CPU count before and after the measurement. A load run raises the load average itself (k6, the twin and PostgreSQL are the load), and the one-minute average decays over about a minute, so read straight after a step it is almost always over the bar: every load finding would be `timing unreliable` by construction. The load harness therefore reads "after" once its own processes have stopped and the average has fallen below the bar, rereading every 5 seconds for up to 120 seconds (`research/load-harness.md`). Two replacements for the load-average gate on timed verdicts were tried on the fixtures: a calibration probe before and after each judged step, and interleaved pairs judged by their per-pair ratio. Neither was adopted (CI run 44609939663): the probe's I/O half disagreed by 17% to 166% around a load step, and per-pair ratios carried both twins' noise. Timed verdicts became counts where the defect allows: L02's revenue as rows read per request, L03 as shared blocks read per request, L05 as the heap slope.

## Q8. The relative timing rule for timed relative verdicts

**Decided, 19 November 2026.** For a timed verdict that compares two conditions measured together: at least 5 repeats; a finding holds when every repeat clears the step's threshold on its own; none clearing is no finding; a mix is `timing unreliable` (info; exit 3 for a planted form). Pairs alternate twin order, so a slowdown tied to run order cannot favour one twin. Spread and load average are recorded and gate nothing. In a load form the two conditions are the two twins of one pair; in a trace form, two requests of one run or start (L09: the blocked stretch against the request's own time; L11: the first request against the cheapest route in the same process). The rule is in `docs/CONTRACT.md` and `lib/timing.js` (`ruleC`).

**Evidence.** On the trial data (CI run 44609939663) no clean twin and no decoy cleared in any repeat, and every mixed case was a real defect near its floor. A second sample (CI run 44663453947) did not meet the adoption condition, every planted defect clearing in 5 of 5 and no clean twin or decoy in any repeat: L11's trace decoy `GET /prices/:id` cleared in all five planted starts against a fixed bar. After L11's trace judge moved to a warm-up and an in-process baseline, a third sample (CI run 44666936253) met it in L09, L11 and L12, load and trace. Closest calls then: L09 load signup, the clean twin's longest stretch at most 34 ms against a floor of 50; L11 load's decoy price at most 53 ms against a floor of 80; L11 trace's decoy `/prices/:id` 4 to 7 ms above the cheapest route against a bar of 20.

**L05, 19 November 2026.** The load form's heap slope is judged per pair under the same rule: a pair clears when the slope is positive, at least 50 bytes a request and three times the other twin's in the same pair (since 20 November 2026, also with a fit of R² 0.5 or better). The trace form's soaks are judged on each twin alone, as a project with no twin would be: a positive slope of 512 bytes a request or more with R² 0.9 or better. Adopted on CI runs 44671874215 and 44673310434: searchProducts and placeCart cleared in 5 of 5 pairs, no clean twin or decoy in any pair, and createOrder stayed the expected miss, cleared in no pair.
