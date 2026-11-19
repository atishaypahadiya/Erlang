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
- L05 measures heap kept per request after a warm-up step, with keys the warm-up did not use.
- Times remain where a row has nothing to count: L02's revenue total and L03's lookups (median), L09 (the share of a cheap route's requests late while a heavy route runs as a second k6 scenario), L11 (the slowest response after a restart).
- L04 judges bytes on the wire; its call per product on the list page is counted per page view by the trace form. L08's leaks (STB-08) and L13's sum of pools across processes (L13-c1) stay with the trace form and the static check.

## The load average after a step

A load step raises the machine's load average itself: k6, the twin and PostgreSQL are the load. The one-minute average decays with a time constant of a minute, so read straight after a step it is nearly always over half the CPU count, and every load finding would be unreliable by construction. The harness therefore reads "after" once its own processes have stopped and a cool-down has passed: it rereads the average every 5 seconds, for up to 120 seconds, until it is below half the CPU count. Not falling in time is recorded and makes the step unreliable. "Before" is read as it is. The rule's purpose, other work on the machine during the measurement, is still caught: other work keeps the average up through the cool-down. This reading of the shared rule is docs/decisions.md, Q6.

## Not covered

- Distributed load, or load from another machine: one k6 process, on the machine that serves the twin.
- Any target ERLANG did not start.
- Absolute thresholds (a p99 of 200 ms): every judgement compares the twins on the same machine, back to back.
