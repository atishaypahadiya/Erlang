# ITTEN timing lock

A lock file that ITTEN writes while it measures time, so ERLANG never generates load on the same machine during those measurements. The rule as the owner decided it (19 November 2026) is in Reading, below, and in `lib/itten-lock.js`; it replaces this proposal where they differ. Load would steal CPU from the browser being timed and skew ITTEN's benchmark, settle windows, motion and frame timing. This file is the spec to carry to ITTEN. ITTEN writes the lock; ERLANG only reads it.

## When ITTEN holds it

ITTEN holds a lock for each phase that measures time and runs alone:

- the benchmark and the watch load, before the jobs start;
- motion and frame timing, after every job and crop.

It takes the lock immediately before the first timed step of a phase and releases it immediately after the last. Between the two phases, while the parallel jobs run, it holds none: those jobs are not timed, and ITTEN already runs them several at once.

## Where

One file per ITTEN process, in a directory shared by every project on the machine:

```
${ITTEN_LOCK_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/itten/locks}/timing-<pid>.json
```

- One file per process, so two ITTEN runs on one machine (two projects, or a parity test that starts a second run) never overwrite each other's lock, and each removes only its own.
- A per-user state directory, not a project's `dist/` (which another project cannot find without knowing where ITTEN lives) and not `/tmp`.
- `ITTEN_LOCK_DIR` overrides the location for tests and CI. Both tools must read the same variable.
- ITTEN creates the directory with mode 0700 if it does not exist.

## Contents

```json
{
  "format": "itten-timing-lock/1",
  "pid": 48211,
  "phase": "benchmark",
  "taken": "2026-11-17T11:02:31.204Z",
  "expires": "2026-11-17T11:07:31.204Z",
  "project": "/home/dev/projects/site"
}
```

| Field | Type | Meaning |
|---|---|---|
| `format` | `"itten-timing-lock/1"` | Format version. |
| `pid` | integer > 1 | The ITTEN process that holds the lock: the Node process, not a browser child. |
| `phase` | `"benchmark"` or `"motion"` | Which timed phase. Informational; ERLANG prints it in its refusal. |
| `taken` | ISO 8601 UTC, milliseconds | When the lock was taken. |
| `expires` | ISO 8601 UTC, milliseconds | After this instant the lock is void whatever the pid. |
| `project` | absolute path | The project being inspected. Informational. |

**Expiry.** `expires` is `taken` plus the phase's expected length (ITTEN already estimates job times from `dist/`) plus a margin of 60 s, and never more than 15 minutes after `taken`. A phase that runs longer than its expiry rewrites the file with a new `expires` (same pid, same `taken`) before the old one passes, at most every 30 s. The cap bounds the damage of a lock left behind by a process that crashed and whose pid has been reused.

## Writing and removing (ITTEN)

1. Write the JSON to `timing-<pid>.json.tmp` in the same directory, then `rename` it to `timing-<pid>.json`. A rename is atomic on one file system, so a reader never sees half a file.
2. Remove the file when the phase ends, in a `finally`, and on `SIGINT` and `SIGTERM`. A crash that skips both leaves a stale file, which the pid check or the expiry voids.
3. On start, ITTEN may delete stale files (dead pid or past expiry) in the directory. It never deletes a file whose pid is alive and whose expiry is in the future.

## Reading (ERLANG)

As decided by the owner, and implemented in `lib/itten-lock.js` (unit cases in `scripts/unit-test.js`):

- **Location.** `timing-<pid>.json` in the first of `$ITTEN_LOCK_DIR`, `$XDG_STATE_HOME/itten/locks` and `$HOME/.local/state/itten/locks` that is set. Only names matching `timing-<digits>.json` are locks. A missing directory means no locks.
- **Active:** the file parses, `format` is `itten-timing-lock/1`, the pid is alive (`kill(pid, 0)` succeeds or fails with `EPERM`) and now is before `expires`. A file that cannot be read or parsed counts as active too.
- **Stale:** the pid is dead, or now is at or past `expires`. ERLANG ignores it and leaves it in place.
- A file that parses, in another `format`, with a live pid and a future expiry is neither: the rule does not make it active, so ERLANG does not wait for it (docs/decisions.md, Q5).
- **Behaviour.** ERLANG generates no load while any lock is active. It waits, rereading about once a second, up to a limit (`ERLANG_LOCK_WAIT_S`, 600 s by default), then stops with exit 75, naming the lock: its file, phase, project, pid and expiry. It rereads immediately before starting load. The trace harness, which is not load, follows the same rule, at its start and before each twin, in place of its earlier check for ITTEN's inspector process.

The load harness also checks during each load step, as proposed: if a lock appears mid-step, ERLANG stops sending, waits for the requests in flight up to their timeout, discards the step's results and reports the step as interrupted.

ERLANG never writes, renews or removes a lock file.

## Not covered

- **The other direction.** ITTEN does not check for ERLANG's load before timing. A load run that starts first and then sees ITTEN's lock stops within one check interval. If that window matters, a symmetric `erlang-load` lock in the same directory, read by ITTEN, closes it; that is ITTEN's call.
- **Other machines.** The lock is per machine. CI jobs run on separate runners, so no lock is needed there unless ITTEN and ERLANG share a self-hosted runner, where the same directory works.
- **Pid reuse.** A crashed ITTEN whose pid is reused by an unrelated process keeps its stale lock active until `expires`, at most 15 minutes. Recording the process's start time as well would close this, at the cost of a platform-specific lookup; the cap was judged enough.

## Test cases (both sides)

| Case | Expected |
|---|---|
| No directory, or an empty one | No lock; load allowed. |
| Live pid, `expires` in the future | Active; load refused, with phase and project named. |
| Dead pid, `expires` in the future | Stale; load allowed. |
| Live pid, `expires` in the past | Stale; load allowed. |
| Unparsable or unreadable file | Active; the stop names the file. |
| Another `format`, live pid, future expiry | Neither active nor stale: not waited for (Q5). |
| Only a `.tmp` file | Ignored; load allowed. |
| Lock appears 10 s into a load step | Sending stops within 5 s; the step is reported interrupted, its results discarded. |
| Two ITTEN processes each hold a lock; one ends | The other's lock still refuses load. |
| `ITTEN_LOCK_DIR` set | Both tools use that directory and no other. |
