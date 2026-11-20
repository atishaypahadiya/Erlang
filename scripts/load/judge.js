// The load judge's entry: no static imports, so a module that fails to load is
// caught here and exits 70, internal failure, not Node's 1, which reads as a
// form that failed. The judge itself is judge-main.js, beside this file.
//
// Usage: node scripts/load/judge.js <form dir> <out dir>
try {
  await import('./judge-main.js');
} catch (e) {
  process.stderr.write(`load judge: internal failure (exit 70): ${e?.stack ?? e}\n`);
  process.exit(70);
}
