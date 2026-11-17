# ERLANG: load and resilience checks

Named after A. K. Erlang; not the Erlang programming language.

ERLANG checks how a web service behaves under load and when its dependencies fail: missing timeouts, retry storms, unbounded queries, per-item queries, exhausted pools. It is the load-and-resilience specialist in a set with ITTEN (design) and KERCKHOFFS (security), and writes the same finding format. It tests the owner's own services only.

Status: research and planning. Nothing runs yet.

- `reference/`: the rules ERLANG checks against, with their sources.
- `research/`: the failure model, prior art, the name, and other design notes.
- `fixtures/PLAN.md`: the planned test bench.

## Part of a set

ERLANG is one of three specialists that check their owner's own projects and write one shared finding format (finding/1 and report/1):

- ITTEN: design.
- KERCKHOFFS: security.
- ERLANG: load and resilience.

## Working on it

After cloning, run `scripts/setup.sh` once to enable the commit hooks.

When it is published, the package will be `@atishaypahadiya/erlang` and the command `erlang`.
