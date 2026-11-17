# Name

Decided 17 November 2026: the name stays **ERLANG**, after A. K. Erlang (1878–1929), who "invented the fields of traffic engineering and queueing theory" (S6 in `reference/SOURCES.md`) with his papers of 1909 and 1917 (S4, S5). It matches the set's convention: a dead scientist whose work is the specialist's domain, as Itten is for colour and Kerckhoffs for cryptography.

The name collides with the Erlang programming language and its runtime, Erlang/OTP. The decisions below keep the two apart wherever a user could confuse them.

## Decisions

| Where | Name | Notes |
|---|---|---|
| README title | `ERLANG: load and resilience checks` | |
| Disambiguation | "Named after A. K. Erlang; not the Erlang programming language." | One line, directly under the title. |
| npm package | `@atishaypahadiya/erlang` | When published. Scoped, because the unscoped `erlang` is taken (below). Unpublished as of 17 November 2026: the registry returns 404 for it. |
| Command | `erlang` | Matches the set's convention (`kerckhoffs`, `itten`). Checked against Erlang/OTP's commands below. |

## The command name against Erlang/OTP

Erlang/OTP puts these commands on the path: `erl`, `erlc`, `escript`, `erl_call`, `epmd`, `run_erl`, `to_erl` and `start_embedded` (Debian's `erlang-base` package for bookworm, its file list under `/usr/bin`), with `ct_run`, `dialyzer` and `typer` built from the same sources (`erts/etc/common` in the OTP repository). None is named `erlang`, so a command called `erlang` does not shadow or get shadowed by an OTP install. On this machine none of them is installed.

What is taken is the **package** name `erlang`: Homebrew's formula `erlang` (29.1.2, "Programming language for highly scalable real-time systems") and Debian's `erlang` install OTP. So:

- `brew install erlang` or `apt install erlang` will never install this tool. If ERLANG is ever packaged for Homebrew or a Linux distribution, the package needs another name; the command can stay `erlang`.
- Docs say `npx @atishaypahadiya/erlang` or `npm install -g @atishaypahadiya/erlang`, never "install erlang".
- On a machine with OTP, typing `erl` and Tab completes to several commands (`erl`, `erlang`, `erlc`, `erl_call`). That is harmless, but it is why the README spells out the command name in full.
- `erlang --version` prints ERLANG's version and the line "load and resilience checks", so nobody mistakes it for OTP.

## Unscoped names taken on npm

`erlang` on npm is an unrelated package, version 1.0.0, "Erlang interoperability with Javascript". Hence the scope.

## Checked

17 November 2026: `npm view erlang`, `npm view @atishaypahadiya/erlang`, https://packages.debian.org/bookworm/amd64/erlang-base/filelist, https://formulae.brew.sh/api/formula/erlang.json, and `gh api repos/erlang/otp/contents/erts/etc/common`.
