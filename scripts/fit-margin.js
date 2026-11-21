#!/usr/bin/env node
// Fit quality in the fixture suite (the owner, 21 November 2026;
// docs/CONTRACT.md, "Margins in the fixture suite"). A planted row judged on
// a fitted heap slope (L05) needs a fit that clears the judge's R² bar with
// room, as a timed row needs a margin over its bar:
//   - margin: the median R² over the row's samples is at least half way from
//     the judge's bar to 1: 0.95 where the bar is 0.9 (the trace's soaks),
//     0.75 where it is 0.5 (the load form's heap slope);
//   - bar: no single sample falls below the judge's own bar.
// A sample short of the margin but at or over the bar is an outlier: printed,
// not failed.
//
// Samples. Under load, the repeats of one run, from its raw.json (each
// repeat's planted heap fitted as the load judge fits it). In a trace, each
// run fits each soak once, so the median is taken across runs: from the
// trace reports of several runs (the release gate: the five CI runs and the
// local run), where every planted row is a finding carrying its R². One trace
// run alone is checked against the bar, and a fit short of the margin is
// printed as an outlier.
//
// The bars are the judges' own: MIN_FIT in scripts/trace/judge-main.js and
// LOAD_R2_MIN in scripts/load/judge-main.js. Those modules run when imported,
// so the values are restated here, and scripts/unit-test.js fails if they
// ever differ from the judges' source.
//
// Usage:
//   node scripts/fit-margin.js trace <form dir> <run dir>      one trace run
//   node scripts/fit-margin.js load <form dir> <run dir>       one load run
//   node scripts/fit-margin.js reports <reports dir> ...       trace reports of
//                                                               several runs
// <run dir> is the form's output (dist/trace/<form>, dist/load/<form>); a
// reports dir holds <form>/<twin>/report.json, as compare-reports.js reads.
// Exit codes: 0 holds (or nothing to judge), 1 fails, 64 bad usage, 70
// internal failure.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slopeOf, MIN_POINTS } from '../lib/trace-judge.js';
import { median } from '../lib/margin.js';

export const TRACE_FIT_BAR = 0.9;
export const LOAD_FIT_BAR = 0.5;
export const fitMarginOf = (bar) => bar + (1 - bar) / 2;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r2s = (xs) => `[${xs.map((x) => (x === null ? 'none' : x.toFixed(3))).join(', ')}]`;

// One row's samples against its bar. Returns { ok, median, margin, below,
// outliers }: below, indices of samples under the bar (a sample with no fit
// counts as under it); outliers, indices at or over the bar but short of the
// margin. judgeMedian false: the bar only (one trace run).
export function fitMargin(samples, bar, judgeMedian = true) {
  const margin = fitMarginOf(bar);
  const below = [];
  const outliers = [];
  samples.forEach((r2, i) => {
    if (r2 === null || !(r2 >= bar)) below.push(i);
    else if (r2 < margin) outliers.push(i);
  });
  const m = median(samples.map((x) => (x === null ? 0 : x)));
  const held = !judgeMedian || m >= margin;
  return { ok: held && !below.length, held, median: m, margin, below, outliers };
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sameRoute = (a, b) => a.method === b.method && (a.route ?? a.path) === (b.route ?? b.path);

// The trace form's planted slope rows: its soaks that are defects (not
// expected misses), by method and route.
function traceRows(spec) {
  if (spec.judge !== 'memory') return [];
  return spec.soaks.filter((s) => (spec.defects ?? []).some((d) => sameRoute(d, s)));
}

// The load form's planted slope rows: heap-slope steps named by a defect.
function loadRows(spec) {
  const planted = new Set((spec.defects ?? []).map((d) => d.step).filter(Boolean));
  return (spec.steps ?? []).filter((s) => s.metric === 'heap-slope' && planted.has(s.id));
}

const lines = [];
let failed = false;
function judgeRow(label, samples, bar, judgeMedian) {
  const v = fitMargin(samples, bar, judgeMedian);
  const head = `${label}: R² ${r2s(samples)}, bar ${bar}`;
  if (judgeMedian) {
    lines.push(`${v.ok ? 'FIT' : 'FAIL'}  ${head}, median ${v.median.toFixed(3)} (margin ${v.margin})${v.held ? '' : ': the median is short of the margin'}${v.below.length ? `: sample(s) ${v.below.map((i) => i + 1).join(', ')} under the bar` : ''}`);
  } else {
    lines.push(`${v.ok ? 'FIT' : 'FAIL'}  ${head} (margin ${v.margin}, judged on the median across runs at the release gate)${v.below.length ? ': under the bar' : ''}`);
  }
  for (const i of v.outliers) lines.push(`OUTLIER  ${label}: sample ${i + 1}, R² ${samples[i].toFixed(3)}, short of the margin ${v.margin} but clearing the bar (not failed)`);
  if (!v.ok) failed = true;
}

function traceRun(formDir, runDir) {
  if (!existsSync(join(formDir, 'trace', 'trace.json'))) return;
  const spec = readJson(join(formDir, 'trace', 'trace.json'));
  const rows = traceRows(spec);
  if (!rows.length) return;
  const raw = readJson(join(runDir, 'planted', 'raw.json'));
  const scale = Object.values(raw.scales).find((s) => s.soaks);
  for (const r of rows) {
    const x = (scale?.soaks ?? []).find((q) => q.id === r.id);
    if (!x) throw new Error(`soak ${r.id}: not in ${join(runDir, 'planted', 'raw.json')}`);
    const f = slopeOf(x.points.filter((p) => p.requests >= r.counts[0]).map((p) => ({ x: p.requests, y: p.heapUsed })));
    judgeRow(`${spec.fixture} ${spec.form} trace ${r.id}`, [f.points >= MIN_POINTS ? f.r2 : null], TRACE_FIT_BAR, false);
  }
}

function loadRun(formDir, runDir) {
  if (!existsSync(join(formDir, 'load', 'load.json'))) return;
  const spec = readJson(join(formDir, 'load', 'load.json'));
  const rows = loadRows(spec);
  if (!rows.length) return;
  const raw = readJson(join(runDir, 'raw.json'));
  for (const r of rows) {
    const samples = raw.repeats.map((rep) => {
      const step = rep.planted.steps.find((s) => s.id === r.id);
      const f = slopeOf((step?.heap?.points ?? []).map((p) => ({ x: p.answered, y: p.heapUsed })));
      return f.points >= MIN_POINTS && f.r2 !== null ? f.r2 : null;
    });
    judgeRow(`${spec.fixture} ${spec.form ?? ''} load ${r.id}`.replace('  ', ' '), samples, LOAD_FIT_BAR, true);
  }
}

// Trace reports of several runs: each planted slope row's R² from its
// finding (erlang.trace.r2), one sample per run; a run without the finding
// is a sample with no fit.
function reportRuns(dirs) {
  const forms = readdirSync(join(ROOT, 'fixtures')).flatMap((f) => {
    const top = join(ROOT, 'fixtures', f);
    if (!statSync(top).isDirectory()) return [];
    const out = [];
    if (existsSync(join(top, 'trace', 'trace.json'))) out.push({ name: f, dir: top });
    for (const sub of readdirSync(top)) {
      if (existsSync(join(top, sub, 'trace', 'trace.json'))) out.push({ name: `${f}/${sub}`, dir: join(top, sub) });
    }
    return out;
  });
  for (const form of forms) {
    const spec = readJson(join(form.dir, 'trace', 'trace.json'));
    for (const r of traceRows(spec)) {
      const samples = dirs.map((d) => {
        const p = join(d, form.name, 'planted', 'report.json');
        if (!existsSync(p)) return null;
        const f = readJson(p).findings.find((x) => x.erlang?.trace?.judge === 'memory' && (x.where?.endpoints ?? []).some((e) => sameRoute(e, r)));
        return f ? f.erlang.trace.r2 : null;
      });
      judgeRow(`${spec.fixture} ${spec.form} trace ${r.id} across ${dirs.length} run(s)`, samples, TRACE_FIT_BAR, true);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  try {
    if (mode === 'trace' && args.length === 2) traceRun(resolve(args[0]), resolve(args[1]));
    else if (mode === 'load' && args.length === 2) loadRun(resolve(args[0]), resolve(args[1]));
    else if (mode === 'reports' && args.length >= 1) reportRuns(args.map((d) => resolve(d)));
    else {
      process.stderr.write('usage: node scripts/fit-margin.js trace|load <form dir> <run dir> | reports <reports dir> ...\n');
      process.exit(64);
    }
  } catch (e) {
    process.stderr.write(`fit-margin: internal failure (exit 70): ${e?.stack ?? e}\n`);
    process.exit(70);
  }
  for (const l of lines) console.log(l);
  process.exit(failed ? 1 : 0);
}
