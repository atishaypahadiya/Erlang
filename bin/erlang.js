#!/usr/bin/env node
// The erlang command's entry: no static imports, so a module that fails to
// load (a missing file, a syntax error, a throw while loading) is caught
// here and exits 70, internal failure, not Node's 1, which reads as failing
// findings. The command itself is lib/erlang.js.
try {
  const { main } = await import('../lib/erlang.js');
  main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`erlang: internal failure (exit 70): ${e?.stack ?? e}\n`);
  process.exit(70);
}
