# ITTEN timing lock

A lock file that ITTEN writes while it measures time, so ERLANG never generates load on the same machine during those measurements. Load would steal CPU from the browser being timed and skew ITTEN's benchmark, settle windows, motion and frame timing. This file is the spec to carry to ITTEN. ITTEN writes the lock; ERLANG only reads it.

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
  "schema": "itten-timing-lock/1",
  "pid": 48211,
  "phase": "benchmark",
  "started": "2026-11-17T11:02:31.204Z",
  "expires": "2026-11-17T11:07:31.204Z",
  "project": "/home/dev/projects/site"
}
```

| Field | Type | Meaning |
|---|---|---|
| `schema` | `"itten-timing-lock/1"` | Format version. A reader that does not know the version treats the lock as active. |
| `pid` | integer > 1 | The ITTEN process that holds the lock: the Node process, not a browser child. |
| `phase` | `"benchmark"` or `"motion"` | Which timed phase. Informational; ERLANG prints it in its refusal. |
| `started` | ISO 8601 UTC, milliseconds | When the lock was taken. |
| `expires` | ISO 8601 UTC, milliseconds | After this instant the lock is void whatever the pid. |
| `project` | absolute path | The project being inspected. Informational. |

**Expiry.** `expires` is `started` plus the phase's expected length (ITTEN already estimates job times from `dist/`) plus a margin of 60 s, and never more than 15 minutes after `started`. A phase that runs longer than its expiry rewrites the file with a new `expires` (same pid, same `started`) before the old one passes, at most every 30 s. The cap bounds the damage of a lock left behind by a process that crashed and whose pid has been reused.

## Writing and removing (ITTEN)

1. Write the JSON to `timing-<pid>.json.tmp` in the same directory, then `rename` it to `timing-<pid>.json`. A rename is atomic on one file system, so a reader never sees half a file.
2. Remove the file when the phase ends, in a `finally`, and on `SIGINT` and `SIGTERM`. A crash that skips both leaves a stale file, which the pid check or the expiry voids.
3. On start, ITTEN may delete stale files (dead pid or past expiry) in the directory. It never deletes a file whose pid is alive and whose expiry is in the future.

## Reading (ERLANG)

A lock is **active** when all of these hold:

- the file's name matches `timing-<digits>.json` (`.tmp` files are ignored);
- it parses as JSON with `schema` equal to `itten-timing-lock/1`;
- `expires` is later than now;
- the pid is alive: `kill(pid, 0)` succeeds, or fails with `EPERM` (the process exists but belongs to another user).

A file that cannot be read, cannot be parsed, or has an unknown `schema` counts as active, and ERLANG's refusal names the file so the owner can inspect and remove it. Failing closed costs a refused run; failing open costs a corrupted ITTEN measurement that nobody notices.

ERLANG refuses to **generate load** while any lock is active: the load steps of a run, and any smoke run. Static checks and trace checks at low rate do not load the machine and are not refused. The refusal prints the phase, the project, the pid and the expiry of each active lock, and exits with a status of its own (not a finding), so CI can tell "refused" from "failed".

ERLANG checks before each load step and again every 5 seconds during it. If a lock appears mid-step, ERLANG stops sending, waits for the requests in flight up to their timeout, discards the step's results (they overlapped a timed phase and are not trusted either way), and reports the step as interrupted. The worst overlap is one check interval plus the in-flight timeout.

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
| Unparsable file, or unknown `schema` | Active; refusal names the file. |
| Only a `.tmp` file | Ignored; load allowed. |
| Lock appears 10 s into a load step | Sending stops within 5 s; the step is reported interrupted, its results discarded. |
| Two ITTEN processes each hold a lock; one ends | The other's lock still refuses load. |
| `ITTEN_LOCK_DIR` set | Both tools use that directory and no other. |
