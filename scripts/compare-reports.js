// Compares the trace reports of several runs of the same commit (the release
// gate, docs/CONTRACT.md): each argument is a directory holding
// <form>/<twin>/report.json, as scripts/trace.sh writes under dist/trace/.
// Every report must be identical in every run, apart from what a machine
// measures. What is measured is read from the reports, never decided here:
//   - each finding's own `measured` list (finding/1): the paths of its
//     fields that differ between runs ([] for each item of a list). For
//     "message", the message is left out when the finding carries its
//     template (erlang.template: the message with each value as {name}),
//     and compared with its numbers masked when it does not;
//   - the report's `started` and `environment` (when and where it ran).
// Everything else is compared in full: the set of findings, verdicts,
// rules, severities, fingerprints, locations, fixes, declared values
// (erlang.values.declared) and message templates. A finding present in one
// run and not another, or a severity that changes, is a difference.
//
// Usage: node scripts/compare-reports.js <dir> <dir> [<dir> ...]
// Exit codes: 0 identical, 1 a difference (each printed with every run's
// value, and the measured values of the form so its repeats can be read),
// 64 bad usage, 70 internal failure.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { exitOnCrash } from '../lib/crash.js';
import { dropPath } from '../lib/values.js';

exitOnCrash('compare-reports');

const dirs = process.argv.slice(2);
if (dirs.length < 2 || dirs.some((d) => !existsSync(d) || !statSync(d).isDirectory())) {
  console.error('usage: node scripts/compare-reports.js <dir> <dir> [<dir> ...]');
  process.exit(64);
}

const REPORT_MEASURED = ['started', 'environment'];

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

function normalize(report) {
  const r = structuredClone(report);
  for (const k of REPORT_MEASURED) delete r[k];
  if (r.erlang) for (const k of REPORT_MEASURED) delete r.erlang[k];
  r.findings = (r.findings ?? []).map((f) => {
    for (const p of f.measured ?? []) {
      if (p !== 'message') dropPath(f, p);
      else if (typeof f.erlang?.template === 'string') delete f.message;
      else f.message = String(f.message).replace(/\d[\d,.]*/g, '#');
    }
    return f;
  });
  return r;
}

// What a machine measured in a report: printed beside a difference.
function measured(report) {
  return (report.findings ?? []).filter((f) => Object.keys(f.erlang?.values?.measured ?? {}).length).map((f) =>
    `${f.severity} ${f.check} ${f.where?.endpoints?.[0] ? `${f.where.endpoints[0].method} ${f.where.endpoints[0].route}` : f.fingerprint}: ${JSON.stringify(f.erlang.values.measured)}`);
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
