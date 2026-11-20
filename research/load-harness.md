# Load harness

The third channel of `fixtures/PLAN.md`: each fixture's twins served on 127.0.0.1 and driven by k6 at a fixed arrival rate, the planted twin judged against the clean one. Built in milestone 9; the load column of each row in milestone 10. This note is the design; `docs/CONTRACT.md` states the interface.

## What is decided already

From `fixtures/PLAN.md` (Ground rules, Stack, Decisions) and the owner's rules:

- **k6, external.** ERLANG runs the `k6` the user or CI installed, as a separate process, and reads its output. It never vendors, bundles, modifies or links k6 (AGPL-3.0; `research/prior-art.md`). With no `k6` on the path it stops with an install hint. CI installs k6 v2.3.0 from Grafana's release, checked against its SHA-256.
- **Open model.** k6's `constant-arrival-rate` executor: requests start at a fixed rate whatever the service does, so a slow service builds a queue instead of slowing the test (the closed-model mistake that hides overload).
- **Loopback only.** The target is the twin the harness started, on 127.0.0.1, on a port the system picked. The guard (`lib/load-guard.js`) refuses any other host, whatever the flags; there is no override.
- **Caps.** Rate and duration are capped per step and per run, and the run log records the target, the rate and the duration of every step.
- **ITTEN's timing lock** (`lib/itten-lock.js`): read before each step, and every 5 seconds during it. A lock that appears mid-step stops k6 and voids that twin's repeat, which runs again from scratch once the lock is gone (five times at most, then exit 75); at the wait's limit the run stops with exit 75, naming the lock.
- **The timing rule, for every timed load finding.** Verdicts on counts, or on shares with no time limit in them (statements, calls, connections, bytes, the share of requests that failed), are exempt (the owner, 19 November 2026); their load averages are recorded as information. Each judged quantity is measured at least 3 times, with a relative spread of 10% or less, and the one-minute load average below half the CPU count before and after. Otherwise the finding is `info`, reason `timing unreliable`, with the environment recorded, and never fails.
- **PostgreSQL**: the trace harness's image, pinned by digest, a password made for each run, the container removed on exit.
- **Where.** The full suite runs in CI. On the owner's Mac one form at a time, within the workstation caps (200 requests a second, 20 s a step, 600 s a run), and never while ITTEN holds its lock.

## Shape

`scripts/load.sh [form ...]`, beside `scripts/trace.sh` and sharing its pieces: the container, the installs, `scripts/trace/serve.js` (every server on 127.0.0.1, every outbound call to the stub), the seed. Each form has `load/load.json` beside `trace/`:

```json
{
  "fixture": "L12", "judge": "shedding",
  "steps": [{ "id": "past-knee", "method": "GET", "path": "/work", "rate": 200, "seconds": 20 }],
  "repeats": 3,
  "defects": [{ "check": "no-load-shedding", "rule": "OVL-02", "method": "GET", "route": "/work" }]
}
```

For each repeat, the planted twin and then the clean twin, each fresh, each step: the lock is read, the load average recorded, k6 run with a scenario the harness writes at run time (`dist/load/<form>/<twin>/scenario.js`), its per-request results read from k6's JSON output, the twin's own probes read (pool, heap, event loop, connections at the database), and the load average recorded again after a cool-down (below).

## The judges, per row

Counts where a row has one, times only where it does not, and always planted against clean:

| Row | Judged under load |
|---|---|
| L01a, L01b | Statements per request (pg_stat_statements over the step) at two page or batch sizes |
| L02 | Response bytes and median latency at 1x and 10x data |
| L03 | Median latency against the twin, at 10x data |
| L04 | Bytes per request; time to load one page view |
| L05 | Heap after a full collection keeps rising over a soak with unique keys, and does not fall after it |
| L06 | Attempts the stub counts per user request, with the stub failing |
| L07 | Requests in flight and open sockets grow while the stub hangs |
| L08 | Errors acquiring a connection once concurrency passes the pool size |
| L09 | Latency of `GET /health` while `/signup` is under load |
| L10 | Throughput against the twin |
| L11 | First-request latency after a restart against steady state |
| L12 | Past the knee: the twin keeps goodput flat and refuses the excess quickly; the planted service's goodput falls and its p99 grows (CAP-02) |
| L13 | Connection errors once the pools of several processes fill |

## What each row's form judges, as built

Counts wherever a row has one, since a count holds on a busy machine and a time does not:

- L01a, L01b and L10 count statements per request; L10's "throughput against the twin" became statements per request, which is what a cache saves and does not depend on the machine.
- L06 counts calls per request to the failing host. A retry with no wait (RTY-03) changes no count, so under load it is a decoy; the trace form judges it by its gaps.
- L07 counts calls held open at the hanging host; L08, the share of requests that fail acquiring a connection; L13 compose, connections at the database.
- L05 measures heap kept per request after a warm-up step, with keys the warm-up did not use: the slope of the heap after full collections against responses answered, read about every 2 s through the step. Its `createOrder` leak (about 1.6 times the clean twin's own retention) is an expected miss, below the floor; `placeCart`, an idempotency store keeping each cart, is the leak above it.
- Counts replace times where the defect allows (the owner, 19 November 2026): L02's revenue total by rows read per request, L03's lookups by shared blocks read per request.
- Times remain where a row has nothing to count: L09 (signup by the event loop's longest stretch, with signups at 2 a second, below what fills the CPUs; login and export by the share of a cheap route's requests late while the heavy route runs as a second k6 scenario), L11 (the slowest response after a restart), L12 (the shedding gap).
- L04 judges bytes on the wire; its call per product on the list page is counted per page view by the trace form. L08's leaks (STB-08) and L13's sum of pools across processes (L13-c1) stay with the trace form and the static check.

## The load average after a step

A load step raises the machine's load average itself: k6, the twin and PostgreSQL are the load. The one-minute average decays with a time constant of a minute, so read straight after a step it is nearly always over half the CPU count, and every load finding would be unreliable by construction. The harness therefore reads "after" once its own processes have stopped and a cool-down has passed: it rereads the average every 5 seconds, for up to 120 seconds, until it is below half the CPU count. Not falling in time is recorded and makes the step unreliable. "Before" is read as it is. The rule's purpose, other work on the machine during the measurement, is still caught: other work keeps the average up through the cool-down. This reading of the shared rule is docs/decisions.md, Q6.

## Not covered

- Distributed load, or load from another machine: one k6 process, on the machine that serves the twin.
- Any target ERLANG did not start.
- Absolute thresholds (a p99 of 200 ms): every judgement compares the twins on the same machine, back to back.

## The timing trial (docs/decisions.md, Q6 and Q7; not adopted)

Two replacements for the load-average gate on timed verdicts were tried on CI run 44609939663, five pairs a form: (a) a calibration probe (a fixed CPU and I/O workload) before and after every judged step, reliable when its timings agree within 10%; (b) whole-run pairs in alternating order, every pair showing the finding, the 10% spread on the per-pair ratios. Neither made a form pass that failed under the current rule, and neither was adopted (the owner, 19 November 2026): around a load step the probe's I/O half disagreed by 17 to 166% (PostgreSQL writing out what the load wrote), and per-pair ratios carry both twins' noise, so their spread was wider than the planted samples'. The probe is gone from the harness; the pairs stay, as the repeats.

What came of it: counts where the defect allows (L02 rows, L03 blocks), the heap slope for L05, and L09's signup on the event loop's longest stretch at a rate below saturation. The verdicts that stay timed and relative (L09, L11, L12) are judged under the relative timing rule (docs/decisions.md, Q8; `docs/CONTRACT.md`): five pairs in alternating twin order, every pair clearing, none, or a mix (unreliable), with spread and load average recorded only.

## Headroom (the owner, 20 November 2026)

A verdict that compares the twins under load assumes the clean twin has room to spare. L09's export broke that: its clean twin built a 30 MB JSON and a SHA-256 on the event loop for every export, 90 to 136 ms a request on CI, so at 6 exports a second its loop was busy about two thirds of the time and its late share swung from 0.00 to 0.53 with the runner (CI run 44682458078).

`scripts/trace.sh --headroom` serves each load form's clean twin against a fresh database and, for every step, sends the step's request (and its background's) one at a time: 3 to warm up, then 10 measured with the twin's event-loop utilisation (`performance.eventLoopUtilization`, the `elu-reset` and `elu` probes). Main-thread time per request is the busy time over the 10. The busy share at the step's rate is the step's rate times that time, plus the background's rate times its time. `scripts/headroom/judge.js` fails a form whose clean twin is over 0.2 at any step; CI runs it on every form.

With the JSON made once but kept as a string, the clean export still took 19.2 ms of main thread a request (0.119 at 6 a second): `zlib.gzip` encodes a string to bytes on the main thread before handing it to the thread pool, 14.6 of those ms on 20 MB. Both twins now keep the bytes: 5.0 ms an export, 0.034, so a runner twice as slow stays under the bar.

The event-loop monitor the loop probes use samples every 1 ms and wakes the main thread about 1,000 times a second, so it is enabled only when a probe first asks for it; with it always on, a request that waits 3 s on a hanging host counted about 50 ms of the monitor's own time (L07's first measurement, 0.53).
