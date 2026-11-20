// Compares the trace reports of several runs of the same commit (the release
// gate, docs/CONTRACT.md): each argument is a directory holding
// <form>/<twin>/report.json, as scripts/trace.sh writes under dist/trace/.
// Every report must be identical in every run, apart from what a machine
// measures rather than counts:
//   - `started`;
//   - any `timing`, `environment`, `ms`, `times`, `heapBytesPerRequest` or
//     `cooledAfterS` (timings, load averages, heap readings);
//   - in a finding judged on a measurement (trace judge `timing` or
//     `memory`), its `slope`, `r2` and `message`, which quote the measured
//     numbers.
// Counts, verdicts, severities, fingerprints, locations, fixes and the set of
// findings are compared as they are. A finding that is present in one run and
// not another, or a severity that changes (a timed verdict that is a finding
// in one run and info in another), is a difference.
//
// Usage: node scripts/compare-reports.js <dir> <dir> [<dir> ...]
// Exit codes: 0 identical, 1 a difference (each printed with every run's
// value, and the measured values of the form so its repeats can be read),
// 64 bad usage, 70 internal failure.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { exitOnCrash } from '../lib/crash.js';

exitOnCrash('compare-reports');

const dirs = process.argv.slice(2);
if (dirs.length < 2 || dirs.some((d) => !existsSync(d) || !statSync(d).isDirectory())) {
  console.error('usage: node scripts/compare-reports.js <dir> <dir> [<dir> ...]');
  process.exit(64);
}

const MEASURED_KEYS = new Set(['started', 'timing', 'environment', 'ms', 'times', 'heapBytesPerRequest', 'cooledAfterS']);
const MEASURED_JUDGES = new Set(['timing', 'memory']);

// Every report.json under a directory, by its path relative to it.
function reportsOf(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === 'report.json') out.set(relative(dir, p), JSON.parse(readFileSync(p, 'utf8')));
    }
  };
  walk(dir);
  return out;
}

function strip(x) {
  if (Array.isArray(x)) return x.map(strip);
  if (!x || typeof x !== 'object') return x;
  return Object.fromEntries(Object.entries(x).filter(([k]) => !MEASURED_KEYS.has(k)).map(([k, v]) => [k, strip(v)]));
}

function normalize(report) {
  const r = strip(report);
  r.findings = (report.findings ?? []).map((f) => {
    const g = strip(f);
    if (MEASURED_JUDGES.has(f.erlang?.trace?.judge)) {
      delete g.message;
      delete g.erlang.trace.slope;
      delete g.erlang.trace.r2;
    }
    return g;
  });
  return r;
}

// What a machine measured in a report: printed beside a difference.
function measured(report) {
  return (report.findings ?? []).filter((f) => f.erlang?.trace).map((f) => {
    const t = f.erlang.trace;
    return `${f.severity} ${f.check} ${f.where?.endpoints?.[0] ? `${f.where.endpoints[0].method} ${f.where.endpoints[0].route}` : f.fingerprint}: ${[t.timing?.samples ? `samples ${JSON.stringify(t.timing.samples.map((v) => Number(Number(v).toFixed(1))))}` : '', t.slope != null && MEASURED_JUDGES.has(t.judge) ? `slope ${t.slope}${t.r2 != null ? ` R² ${t.r2}` : ''}` : ''].filter(Boolean).join(', ') || 'counts only'}`;
  });
}

// Paths at which two values differ, as a.b[2].c.
function diffs(a, b, path = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b) && (!Array.isArray(a) || a.length === b.length)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffs(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : path ? `${path}.${k}` : k, out);
    return out;
  }
  out.push(path || '(the whole report)');
  return out;
}
const at = (x, path) => path.split(/\.|\[|\]/).filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), x);

const runs = dirs.map((d) => ({ dir: d, reports: reportsOf(d) }));
const names = [...new Set(runs.flatMap((r) => [...r.reports.keys()]))].sort();
let differ = 0;
for (const name of names) {
  const missing = runs.filter((r) => !r.reports.has(name));
  if (missing.length) {
    differ++;
    console.log(`DIFFERS  ${name}: missing in ${missing.map((r) => r.dir).join(', ')}`);
    continue;
  }
  const norm = runs.map((r) => normalize(r.reports.get(name)));
  const paths = [...new Set(norm.slice(1).flatMap((n) => diffs(norm[0], n)))];
  if (!paths.length) continue;
  differ++;
  console.log(`DIFFERS  ${name}`);
  for (const p of paths.slice(0, 20)) {
    console.log(`  ${p}`);
    for (const [k, r] of runs.entries()) console.log(`    ${r.dir}: ${JSON.stringify(at(norm[k], p))?.slice(0, 300)}`);
  }
  console.log('  measured, per run:');
  for (const r of runs) for (const line of measured(r.reports.get(name))) console.log(`    ${r.dir}: ${line}`);
}
console.log(differ ? `${differ} of ${names.length} report(s) differ across ${runs.length} runs` : `IDENTICAL  ${names.length} report(s) across ${runs.length} runs (apart from what is measured: docs/CONTRACT.md)`);
process.exit(differ ? 1 : 0);
