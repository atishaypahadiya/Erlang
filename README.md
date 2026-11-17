# ERLANG: load and resilience checks

Named after A. K. Erlang; not the Erlang programming language.

ERLANG checks how a web service behaves under load and when its dependencies fail: missing timeouts, retry storms, unbounded queries, per-item queries, exhausted pools. It is the load-and-resilience specialist in a set with ITTEN (design) and KERCKHOFFS (security), and writes the same finding format. It tests the owner's own services only.

Status: one static check is built, `no-timeout` (rule TMO-01). It reports outbound calls that nothing bounds in time, from fetch, axios, got, `node:http`/`node:https` and `pg`, and suggests a fix for each. ERLANG reads source and runs nothing; checks that need traces or generated load come later.

```
npm install
node bin/erlang.js <dir> [--out <file>]
```

It writes a report/1 to `dist/reports/<dir name>/report.json`, or to `<file>`. Exit codes:

- 0: complete, with no findings.
- 1: findings.
- 2: refused.
- 3: partial, with no findings.
- 64: bad usage.

`erlang.config.json` at `<dir>` can exclude paths that are not part of the app. `npm test` runs every test, including a scan of this repository, which must come back clean.

- `reference/`: the rules ERLANG checks against, with their sources.
- `research/`: the failure model, prior art, the name, and other design notes. `research/first-check.md` explains why `no-timeout` came first.
- `fixtures/`: the test bench (`fixtures/PLAN.md`). `L07-no-timeout/` is built.
- `core/`: a pinned, temporary copy of the shared finding/1 and report/1 code (`core.pin.json`).

## Part of a set

ERLANG is one of three specialists that check their owner's own projects and write one shared finding format (finding/1 and report/1):

- ITTEN: design.
- KERCKHOFFS: security.
- ERLANG: load and resilience.

## Working on it

After cloning, run `scripts/setup.sh` once to enable the commit hooks.

When it is published, the package will be `@atishaypahadiya/erlang` and the command `erlang`.
