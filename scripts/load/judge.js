// Judges one fixture form's load run (scripts/trace/run.js --load) and writes
// a report/1 per twin. Needs no Docker or k6: it reads raw.json, so a
// recorded run can be judged again.
//
// Each twin is judged against the other, run on the same machine, back to
// back, never against an absolute number (fixtures/PLAN.md): a twin reports
// a finding when it does markedly worse than the other on a defect's step.
// The planted twin should; the clean twin, held to the same test, should
// not. Every load finding goes through the timing rule (lib/timing.js): the
// judged quantity in each repeat (three or more), a relative spread of 10% or
// less, and the load average below half the CPU count before and after every
// step (after: once cooled, docs/decisions.md, Q6). Otherwise it is info, timing
// unreliable, and never fails. A finding that agrees with a static finding
// (check, rule, and the symbol or endpoint) is that finding, with load added
// to its detection.
//
// Usage: node scripts/load/judge.js <form dir> <out dir>
// Exit codes: 0 both twins as expected, 1 not.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finding, fingerprint } from '../../core/finding.js';
import { report } from '../../core/report.js';
import { validate } from '../../core/schema.js';
import { scan, VERSION } from '../../bin/erlang.js';
import { judge as timingJudge, REASON } from '../../lib/timing.js';
import { agree } from '../../lib/calibration.js';
import { linkStatic, fmt } from '../../lib/trace-judge.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const extensionSchema = JSON.parse(readFileSync(join(ROOT, 'schema', 'finding-erlang.schema.json'), 'utf8'));
const [formDir, outDir] = process.argv.slice(2).map((p) => p && resolve(p));
if (!formDir || !outDir) {
  console.error('usage: node scripts/load/judge.js <form dir> <out dir>');
  process.exit(64);
}
const spec = JSON.parse(readFileSync(join(formDir, 'load', 'load.json'), 'utf8'));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (x) => `${Math.round(100 * x)}%`;

// judge "shedding" (L12): past the knee, the share of offered requests
// served within the step's okMs (goodput), this twin against the other. A
// twin that keeps SHED_GAP less of its offered load as goodput than the other,
// while both kept at least CONTROL_SHARE at the control step below the knee,
// queues what it cannot serve instead of refusing it (OVL-02, CAP-02).
const SHED_GAP = 0.25;
// judge "compare": each judged step names a metric; a twin reports when its
// metric, the median over the repeats, is at least the step's ratio (RATIO
// by default) times the other twin's, and at least the step's floor.
const RATIO = 1.5;
// Verdicts on counts, or on shares with no time limit in them, are exempt
// from the timing rule (the owner, 19 November 2026): statements, calls,
// connections, bytes, and the share of requests that failed. Everything
// else is timed: latencies, the share answered late (a time limit), the
// shedding gap (served within okMs), and heap kept per request (neither a
// count nor a share; it moves with the collector and the machine).
const EXEMPT = new Set(['statements', 'attempts', 'stub-open', 'connections', 'bytes', 'failed']);
// The verdict of an exempt quantity: recorded like the timing rule's, with
// the load averages kept as information, and always reliable.
const exempt = ({ samples, before, after }) => {
  const xs = samples.filter((x) => Number.isFinite(x));
  const med = xs.length ? median(xs) : null;
  return { reliable: true, exempt: true, reason: null, why: [], samples: xs, median: med, spread: xs.length && med > 0 ? (Math.max(...xs) - Math.min(...xs)) / med : null, before: before ?? null, after: after ?? null };
};
const JUDGE_OF = { 'stub-open': 'inflight', failed: 'pool-errors', connections: 'connection-errors', p99: 'latency', p90: 'latency', median: 'latency', max: 'first-request', 'late-share': 'throughput', 'heap-growth': 'memory' };
const METRICS = {
  statements: { what: 'statements per request', of: (s) => (s.counts.requests ? (s.statements?.calls ?? 0) / s.counts.requests : 0), fmt: (x) => x.toFixed(1) },
  attempts: { what: 'calls to the failing host per request', of: (s, step) => (offered(s) ? (s.upstream ?? []).filter((u) => u.host === step.host).reduce((a, u) => a + u.calls, 0) / offered(s) : 0), fmt: (x) => x.toFixed(1) },
  failed: { what: 'share of requests that failed', of: (s) => (offered(s) ? s.counts.failed / offered(s) : 0), fmt: pct },
  'stub-open': { what: 'calls held open at the hanging host, at most', of: (s) => Math.max(0, ...s.samples.map((x) => (Number.isFinite(x['stub-open']) ? x['stub-open'] : 0))), fmt: (x) => String(Math.round(x)) },
  connections: { what: 'connections open at the database, at most', of: (s) => Math.max(0, ...s.samples.map((x) => (Number.isFinite(x.connections) ? x.connections : 0))), fmt: (x) => String(Math.round(x)) },
  p99: { what: 'p99 latency of the requests served, in ms', of: (s) => s.served?.p99Ms ?? 0, fmt: (x) => String(Math.round(x)) },
  p90: { what: 'p90 latency of the requests served, in ms', of: (s) => s.served?.p90Ms ?? 0, fmt: (x) => String(Math.round(x)) },
  median: { what: 'median latency of the requests served, in ms', of: (s) => s.served?.medMs ?? 0, fmt: (x) => x.toFixed(1) },
  max: { what: 'slowest response, in ms', of: (s) => s.served?.maxMs ?? 0, fmt: (x) => String(Math.round(x)) },
  // Bytes on the wire per request (k6's data_received, headers included,
  // compressed as sent), for a step with no background.
  bytes: { what: 'bytes on the wire per response', of: (s) => (s.counts.requests ? (s.counts.wireBytes ?? 0) / s.counts.requests : 0), fmt: (x) => fmt(Math.round(x)) },
  'late-share': { what: 'share of requests not answered in time', of: (s) => (offered(s) ? 1 - s.counts.ok / offered(s) : 0), fmt: pct },
  'heap-growth': { what: 'bytes of heap kept per request, after a full collection', of: (s) => (s.heap?.after != null && s.counts.requests ? Math.max(0, (s.heap.after - s.heap.before) / s.counts.requests) : 0), fmt: (x) => fmt(Math.round(x)) },
};
const CONTROL_SHARE = 0.9;

// ---- The timing trial (docs/decisions.md, Q6; on trial, not the rule). Three
// rules judge the same runs; only "current" decides the exit code and writes
// the reports:
//   current  the timing rule: three or more samples, spread 10% or less, the
//            load average below half the CPUs before and after;
//   probe    (a): the same samples and spread, the load-average gate replaced
//            by the calibration probe (lib/calibration.js) around every run
//            of the step, both twins: all probes agree within 10%;
//   paired   (a)+(b): the pairs (planted and clean runs, in alternating
//            order), five or more; the finding holds only if every pair shows
//            it, and the 10% spread applies to the per-pair ratios (the
//            per-pair gaps for shedding); the probes as in (a).
// The load averages are kept as information under probe and paired.
const MIN_PAIRS = 5;
const MAX_SPREAD = 0.10;
// The heap slope (trial, L05): the heap after a full collection against the
// responses answered, fitted by least squares over a step's points (5 or
// more). A finding needs a positive slope in every repeat, each fit at least
// MIN_R2, the median slope at least the step's floor and ratio times the
// other twin's; the probes as in (a).
const MIN_POINTS = 5;
const MIN_R2 = 0.9;
function fit(points) {
  const ps = (points ?? []).filter((p) => Number.isFinite(p.answered) && Number.isFinite(p.heapUsed));
  if (ps.length < 2) return { slope: null, r2: null, points: ps.length };
  const mx = ps.reduce((a, p) => a + p.answered, 0) / ps.length;
  const my = ps.reduce((a, p) => a + p.heapUsed, 0) / ps.length;
  const sxx = ps.reduce((a, p) => a + (p.answered - mx) ** 2, 0);
  const sxy = ps.reduce((a, p) => a + (p.answered - mx) * (p.heapUsed - my), 0);
  const syy = ps.reduce((a, p) => a + (p.heapUsed - my) ** 2, 0);
  if (!sxx) return { slope: null, r2: null, points: ps.length };
  const slope = sxy / sxx;
  return { slope, r2: syy ? (sxy * sxy) / (sxx * syy) : 0, points: ps.length };
}
// The smallest value a quantity can be told apart from zero, for a ratio
// whose other side measured nothing: a share's one request in a hundred, a
// millisecond, a byte.
const RESOLUTION = { 'late-share': 0.01, failed: 0.01, median: 1, p90: 1, p99: 1, max: 1, 'heap-growth': 1 };
const spreadOf = (xs) => { const m = median(xs); return xs.length && m > 0 ? (Math.max(...xs) - Math.min(...xs)) / m : null; };
const probesOf = (raw, id) => raw.repeats.flatMap((rep) => ['planted', 'clean'].flatMap((t) => { const p = rep[t].steps.find((x) => x.id === id)?.environment?.probe; return p ? [p.before, p.after] : []; }));
function trialVerdict({ samples, probes, before, after, minSamples }) {
  const why = [];
  const xs = samples.filter((x) => Number.isFinite(x));
  const spread = spreadOf(xs);
  if (xs.length < minSamples) why.push(`${xs.length} sample(s), fewer than ${minSamples}`);
  else if (spread === null || spread > MAX_SPREAD) why.push(`spread ${spread === null ? 'unknown' : `${(spread * 100).toFixed(1)}%`}, over ${MAX_SPREAD * 100}%`);
  const p = agree(probes);
  why.push(...p.why);
  return { reliable: why.length === 0, reason: why.length ? REASON : null, why, samples: xs.map((x) => Number(x.toFixed(4))), median: xs.length ? median(xs) : null, spread, before: before ?? null, after: after ?? null };
}

const NOTE = {
  'OVL-02': 'Cap the requests in flight and answer the excess with 503 and Retry-After at once; find the cap with a load test stepped past the knee (CAP-02).',
};

function stepOf(rep, twin, id) {
  const s = rep[twin].steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id} recorded for the ${twin} twin`);
  return s;
}
const offered = (s) => (s.counts.requests ?? 0) + (s.counts.dropped ?? 0);
const share = (s) => (offered(s) ? s.counts.ok / offered(s) : 0);

// The worst environment over every step of both twins: the highest load
// average before, and after (a step that never cooled counts as over).
function environments(raw) {
  const all = raw.repeats.flatMap((rep) => ['planted', 'clean'].flatMap((t) => rep[t].steps.map((s) => s.environment)));
  const worst = (key) => all.reduce((w, e) => {
    const x = e[key];
    const load = key === 'after' && x.cooledAfterS === null ? Math.max(x.load1, x.cpus / 2) : x.load1;
    return !w || load > w.load1 ? { load1: load, cpus: x.cpus, ...(key === 'after' ? { cooledAfterS: x.cooledAfterS ?? null } : {}) } : w;
  }, null);
  return { before: worst('before'), after: worst('after') };
}

const staticsOf = new Map();
function judgeTwin(raw, twin, rule = 'current') {
  const other = twin === 'planted' ? 'clean' : 'planted';
  const subjectDir = join(formDir, twin);
  if (!staticsOf.has(twin)) staticsOf.set(twin, scan(subjectDir).findings);
  const statics = staticsOf.get(twin);
  const out = [];
  const env = environments(raw);
  const interrupted = raw.repeats.some((rep) => ['planted', 'clean'].some((t) => rep[t].steps.some((s) => s.interrupted)));
  if (interrupted) throw new Error('a step was interrupted by ITTEN\'s timing lock; its results are discarded: run the form again');

  if (spec.judge === 'shedding') {
    for (const id of spec.control ?? []) {
      for (const rep of raw.repeats) for (const t of ['planted', 'clean']) {
        const s = stepOf(rep, t, id);
        if (share(s) < CONTROL_SHARE) throw new Error(`the ${t} twin served ${pct(share(s))} of step ${id} within ${spec.steps.find((x) => x.id === id)?.okMs ?? 500} ms, below the knee: the fixture or its load form is wrong`);
      }
    }
    for (const id of spec.judged) {
      const runs = raw.repeats.map((rep) => ({ me: stepOf(rep, twin, id), them: stepOf(rep, other, id) }));
      const samples = runs.map((r) => Number((share(r.them) - share(r.me)).toFixed(4)));
      const gap = median(samples);
      if (twin === 'planted' && rule === 'current') MEASURED.push(`step ${id} (goodput gap, clean minus planted): ${JSON.stringify(samples)}; ${verdictOf(timingJudge({ samples, before: env.before, after: env.after }))}`);
      if (rule === 'paired' ? !samples.every((g) => g >= SHED_GAP) : gap < SHED_GAP) continue;
      const timing = rule === 'current' ? timingJudge({ samples, before: env.before, after: env.after })
        : trialVerdict({ samples, probes: probesOf(raw, id), before: env.before, after: env.after, minSamples: rule === 'paired' ? MIN_PAIRS : 3 });
      const s0 = runs[0].me;
      const step = spec.steps.find((x) => x.id === id);
      const medOf = (k, f) => median(runs.map((r) => f(r[k])));
      const mine = { goodputShare: medOf('me', share), refusedShare: medOf('me', (s) => s.counts.refused / offered(s)), failedShare: medOf('me', (s) => s.counts.failed / offered(s)), servedP99Ms: medOf('me', (s) => s.served?.p99Ms ?? 0) };
      const theirs = { goodputShare: medOf('them', share), refusedShare: medOf('them', (s) => s.counts.refused / offered(s)), refusedP99Ms: medOf('them', (s) => s.refusals?.p99Ms ?? 0) };
      const t = { check: 'no-load-shedding', rule: 'OVL-02', method: s0.method, route: s0.route ?? step.route, symbol: spec.defects?.find((d) => d.step === id)?.symbol ?? null };
      const load = { judge: 'shedding', step: id, path: s0.path, rate: step.rate, seconds: step.seconds, repeats: runs.length, samples, twin: mine, other: theirs, timing: { ...timing, why: Array.isArray(timing.why) ? (timing.why.join('; ') || null) : timing.why ?? null } };
      const message = `Past the knee, at ${fmt(step.rate)} requests a second for ${step.seconds} s, ${t.method} ${t.route} answered ${pct(mine.goodputShare)} of them within ${fmt(step.okMs ?? 500)} ms; the twin that caps requests in flight answered ${pct(theirs.goodputShare)} in time and refused ${pct(theirs.refusedShare)} at once (p99 ${fmt(Math.round(theirs.refusedP99Ms))} ms). Here ${pct(mine.failedShare)} failed and those served waited up to ${fmt(Math.round(mine.servedP99Ms))} ms (p99): every request queues, so all are late instead of some refused (OVL-02, CAP-02). Measured with k6 at a fixed arrival rate, ${runs.length} repeats.${timing.reliable ? '' : ` Not judged: ${REASON} (${load.timing.why}).`}`;
      out.push(emit(t, statics, message, load, timing.reliable ? 'warning' : 'info'));
    }
  } else if (spec.judge === 'compare') {
    for (const step of spec.steps.filter((x) => x.metric)) {
      const m = METRICS[step.metric];
      if (!m) throw new Error(`step ${step.id}: unknown metric ${step.metric}`);
      const runs = raw.repeats.map((rep) => ({ me: m.of(stepOf(rep, twin, step.id), step), them: m.of(stepOf(rep, other, step.id), step) }));
      const mine = median(runs.map((r) => r.me));
      const theirs = median(runs.map((r) => r.them));
      const ratio = step.ratio ?? RATIO;
      if (twin === 'planted' && rule === 'current') {
        const r4 = (xs) => JSON.stringify(xs.map((x) => Number(x.toFixed(4))));
        const v = (EXEMPT.has(step.metric) ? exempt : timingJudge)({ samples: runs.map((r) => r.me), before: env.before, after: env.after });
        MEASURED.push(`step ${step.id} (${step.metric}, needs ${ratio}x and ${step.floor ?? 0}): planted ${r4(runs.map((r) => r.me))}, clean ${r4(runs.map((r) => r.them))}; ${v.exempt ? 'a count or share, exempt from the timing rule; ' : ''}${verdictOf(v)}`);
        if (step.metric === 'heap-growth') {
          const fitsOf = (t) => raw.repeats.map((rep) => fit(stepOf(rep, t, step.id).heap?.points)).map((f) => (f.slope === null ? `none (${f.points} point(s))` : `${f.slope.toFixed(1)} B/req R² ${f.r2.toFixed(2)} (${f.points} points)`)).join(', ');
          MEASURED.push(`step ${step.id} heap slope${spec.defects.some((d) => d.step === step.id) ? '' : ' (decoy route)'}: planted ${fitsOf('planted')}; clean ${fitsOf('clean')}`);
        }
      }
      if (rule === 'slope' && step.metric === 'heap-growth') {
        const fits = raw.repeats.map((rep) => ({ me: fit(stepOf(rep, twin, step.id).heap?.points), them: fit(stepOf(rep, other, step.id).heap?.points) }));
        const slopes = fits.map((f) => f.me.slope);
        const mineS = median(slopes.map((x) => x ?? 0));
        const theirsS = median(fits.map((f) => f.them.slope ?? 0));
        if (!(slopes.every((x) => x > 0) && mineS >= (step.floor ?? 0) && mineS >= ratio * Math.max(theirsS, 1))) continue;
        const why = [];
        for (const [k, f] of fits.entries()) {
          if (f.me.points < MIN_POINTS) why.push(`repeat ${k + 1}: ${f.me.points} point(s), fewer than ${MIN_POINTS}`);
          else if (!(f.me.r2 >= MIN_R2)) why.push(`repeat ${k + 1}: fit R² ${f.me.r2?.toFixed(2)}, under ${MIN_R2}`);
        }
        why.push(...agree(probesOf(raw, step.id)).why);
        const s0 = stepOf(raw.repeats[0], twin, step.id);
        const timing = { reliable: !why.length, reason: why.length ? REASON : null, why: why.join('; ') || null, samples: slopes.map((x) => Number((x ?? 0).toFixed(2))), median: mineS, spread: spreadOf(slopes.map((x) => x ?? 0)), before: env.before ?? null, after: env.after ?? null };
        const t = { check: step.check ?? spec.check, rule: step.rule ?? spec.rule, method: s0.method, route: s0.route ?? step.route, symbol: step.symbol ?? null };
        const load = { judge: 'memory', step: step.id, path: s0.path, rate: step.rate, seconds: step.seconds, repeats: fits.length, samples: timing.samples, twin: { 'heap-slope': mineS }, other: { 'heap-slope': theirsS }, timing };
        out.push(emit(t, statics, `${t.method} ${t.route} kept about ${fmt(Math.round(mineS))} bytes of heap per request (least-squares slope after full collections, every repeat positive), against ${fmt(Math.round(theirsS))} for the twin without the defect (STB-05).`, load, timing.reliable ? 'warning' : 'info'));
        continue;
      }
      const res = RESOLUTION[step.metric] ?? 1e-9;
      const pairRatios = runs.map((r) => r.me / Math.max(r.them, res));
      const paired = (rule === 'paired' || rule === 'slope') && !EXEMPT.has(step.metric);
      if (paired ? !runs.every((r, k) => r.me > 0 && r.me >= (step.floor ?? 0) && pairRatios[k] >= ratio) : (!(mine >= (step.floor ?? 0)) || !(mine >= ratio * theirs) || mine === 0)) continue;
      const samples = runs.map((r) => Number(r.me.toFixed(4)));
      const timing = EXEMPT.has(step.metric) ? exempt({ samples, before: env.before, after: env.after })
        : rule === 'current' ? timingJudge({ samples, before: env.before, after: env.after })
          : trialVerdict({ samples: paired ? pairRatios : samples, probes: probesOf(raw, step.id), before: env.before, after: env.after, minSamples: paired ? MIN_PAIRS : 3 });
      const s0 = stepOf(raw.repeats[0], twin, step.id);
      // With a background (L09), the finding is about the background route,
      // whose work slowed the measured one.
      const bg = step.background ?? null;
      const about = bg ? { method: (bg.method ?? 'GET').toUpperCase(), route: bg.route ?? bg.path } : { method: s0.method, route: s0.route ?? step.route };
      const t = { check: step.check ?? spec.check, rule: step.rule ?? spec.rule, ...about, symbol: step.symbol ?? null };
      const load = { judge: step.judge ?? JUDGE_OF[step.metric] ?? step.metric, step: step.id, path: s0.path, rate: step.rate, seconds: step.seconds, repeats: runs.length, samples, twin: { [step.metric]: mine }, other: { [step.metric]: theirs }, timing: { ...timing, why: Array.isArray(timing.why) ? (timing.why.join('; ') || null) : timing.why ?? null } };
      const message = `At ${fmt(step.rate)} requests a second for ${step.seconds} s${step.host ? `, with ${step.host} failing` : ''}${bg ? ` to ${s0.method} ${s0.route ?? step.route}, while ${t.method} ${t.route} ran at ${fmt(bg.rate)} a second,` : ''}, ${bg ? 'it' : `${t.method} ${t.route}`} showed ${m.fmt(mine)} ${m.what}, against ${m.fmt(theirs)} for the twin without the defect (${step.because ?? t.rule}). Measured with k6 at a fixed arrival rate, ${runs.length} repeats.${timing.reliable ? '' : ` Not judged: ${REASON} (${load.timing.why}).`}`;
      out.push(emit(t, statics, message, load, timing.reliable ? (step.severity ?? 'warning') : 'info'));
    }
  } else throw new Error(`unknown load judge ${spec.judge}`);

  for (const f of out) {
    const errors = validate(extensionSchema, f.erlang);
    if (errors.length) throw new Error(`${twin}: ${f.fingerprint}: erlang extension: ${errors.join('; ')}`);
  }
  const r = report({
    specialist: 'erlang', version: VERSION, subject: relative(process.cwd(), subjectDir) || '.', started: new Date(raw.started ?? Date.now()),
    findings: out,
    run: { load: { profile: raw.profile, k6: raw.k6, image: raw.image, fixture: raw.fixture, form: raw.form, twin, judge: spec.judge, repeats: raw.repeats.length, caps: raw.caps } },
  });
  if (rule === 'current') writeFileSync(join(outDir, twin, 'report.json'), JSON.stringify(r, null, 2) + '\n');
  return r;
}

// A load finding: the static finding it agrees with, with load added, or one
// of its own at its endpoint. Fingerprints hold no measured value.
function emit(t, statics, message, load, severity) {
  const s = severity === 'info' ? null : linkStatic(t, statics, () => null);
  if (s) {
    // A static finding left at info because reading could not decide
    // (unresolved) takes the load verdict's severity: the load run decided it.
    const resolves = s.severity === 'info' && s.erlang?.unresolved && severity !== 'info';
    const { unresolved: _u, ...ext } = s.erlang ?? {};
    return finding({
      specialist: 'erlang', check: t.check, severity: resolves ? severity : s.severity, fingerprint: s.fingerprint,
      message: `${s.message} Under load: ${message}`,
      detection: [...new Set([...s.detection, 'load'])], rules: s.rules, where: s.where,
      extension: { ...(resolves ? ext : s.erlang), load },
    });
  }
  const note = NOTE[t.rule];
  return finding({
    specialist: 'erlang', check: t.check, severity, fingerprint: fingerprint(t.check, `${t.method} ${t.route}`, t.rule, 'load'),
    message: note ? `${message} ${note}` : message, detection: ['load'], rules: [t.rule],
    where: { endpoints: [{ method: t.method, route: t.route }] },
    extension: { strength: 'SHOULD', load },
  });
}

const raw = existsSync(join(outDir, 'raw.json')) ? JSON.parse(readFileSync(join(outDir, 'raw.json'), 'utf8')) : null;
// A form passes only when the planted twin yields a failing finding for
// every defect under the timing rule, and the clean twin none. A defect the
// planted twin reports only as "timing unreliable" is not a pass: the form is
// UNRELIABLE (exit 3, nothing failed, nothing confirmed), unless something
// else failed (exit 1).
let failed = false;
let unreliable = false;
// Every judged step's quantities, both twins, per repeat, with the timing
// verdict: printed under the planted twin's line, so a CI log carries them.
const MEASURED = [];
const say = (ok, what, detail, status = ok ? 'PASS' : 'FAIL') => { if (status === 'FAIL') failed = true; if (status === 'UNRELIABLE') unreliable = true; console.log(`${status}  ${spec.fixture} ${spec.form} load ${what}${detail ? `  (${detail})` : ''}`); };
// The timing verdict behind an unreliable finding, for the report: samples,
// spread, load averages before and after.
const verdictOf = (t) => `samples ${JSON.stringify(t.samples)}, spread ${t.spread === null ? 'unknown' : `${(t.spread * 100).toFixed(1)}%`}, load before ${t.before?.load1 ?? '?'}/${t.before?.cpus ?? '?'} CPUs, after ${t.after?.load1 ?? '?'}/${t.after?.cpus ?? '?'}${t.after?.cooledAfterS === null ? ' (never cooled)' : ''}${(Array.isArray(t.why) ? t.why.join('; ') : t.why) ? `: ${Array.isArray(t.why) ? t.why.join('; ') : t.why}` : ''}`;
if (!raw) { say(false, '', 'no raw.json: run scripts/load.sh'); process.exit(1); }
const keyOf = (f) => `${f.check} ${f.rules?.[0] ?? ''} ${f.erlang?.load?.step ?? ''}`;
const matches = (d, f) => d.check === f.check && (!d.rule || f.rules?.includes(d.rule)) && f.erlang?.load?.step === d.step;
for (const twin of ['planted', 'clean']) {
  let r;
  try { r = judgeTwin(raw, twin); } catch (e) { say(false, twin, e.message); continue; }
  const judged = r.findings.filter((f) => f.severity !== 'info');
  const infos = r.findings.filter((f) => f.severity === 'info');
  if (twin === 'planted') {
    const inconclusive = spec.defects.filter((d) => !judged.some((f) => matches(d, f)) && infos.some((f) => matches(d, f) && f.erlang.load.timing.reliable === false));
    for (const d of inconclusive) {
      const f = infos.find((x) => matches(d, x) && x.erlang.load.timing.reliable === false);
      console.log(`UNRELIABLE  ${spec.fixture} ${spec.form} load planted: ${d.check} ${d.rule ?? ''} step ${d.step}: ${REASON} (${verdictOf(f.erlang.load.timing)})`);
    }
    const missing = spec.defects.filter((d) => !judged.some((f) => matches(d, f)) && !inconclusive.includes(d));
    const extra = judged.filter((f) => !spec.defects.some((d) => matches(d, f)));
    const unlinked = spec.defects.filter((d) => d.linked && judged.some((f) => matches(d, f) && !f.detection.includes('static')));
    const wrong = missing.length || extra.length || unlinked.length;
    say(!wrong && !inconclusive.length, `planted: ${judged.length - extra.length}/${spec.defects.length} defects found under load${inconclusive.length ? ` (${inconclusive.length} timing unreliable)` : ''}`,
      [...missing.map((d) => `missed ${d.check} step ${d.step}`), ...extra.map((f) => `decoy reported: ${keyOf(f)}`), ...unlinked.map((d) => `not linked: step ${d.step}`), ...infos.map((f) => `info: ${keyOf(f)}`)].join('; '), wrong ? 'FAIL' : inconclusive.length ? 'UNRELIABLE' : 'PASS');
    for (const m of MEASURED) console.log(`      measured ${m}`);
    for (const f of extra) console.log(`      ${f.message}`);
  } else {
    say(!judged.length, `clean: ${judged.length} error(s) or warning(s)`, [...judged.map((f) => `reported: ${keyOf(f)}`), ...infos.map((f) => `info: ${keyOf(f)}`)].join('; '));
  }
}
// The timing trial (Q6): the same runs under each rule, one line per form,
// with the clean twin's failing findings (false positives) and the decoys
// the planted twin reported, and why each unreliable defect was so. Printed
// only; the exit code is the current rule's.
const outcome = (rule) => {
  let p;
  let c;
  try { p = judgeTwin(raw, 'planted', rule); c = judgeTwin(raw, 'clean', rule); } catch (e) { return { status: 'FAIL', note: e.message, cleanFp: '?', decoys: '?', why: [] }; }
  const judged = p.findings.filter((f) => f.severity !== 'info');
  const infos = p.findings.filter((f) => f.severity === 'info' && f.erlang.load.timing.reliable === false);
  const unrel = spec.defects.filter((d) => !judged.some((f) => matches(d, f)) && infos.some((f) => matches(d, f)));
  const missing = spec.defects.filter((d) => !judged.some((f) => matches(d, f)) && !unrel.includes(d));
  const extra = judged.filter((f) => !spec.defects.some((d) => matches(d, f)));
  const cleanFp = c.findings.filter((f) => f.severity !== 'info').length;
  const status = missing.length || extra.length || cleanFp ? 'FAIL' : unrel.length ? 'UNRELIABLE' : 'PASS';
  const why = unrel.map((d) => { const t = infos.find((f) => matches(d, f)).erlang.load.timing; return `step ${d.step}: ${t.why}`; });
  return { status, cleanFp, decoys: extra.length, missed: missing.map((d) => d.step), why };
};
const rules = [['current', 'current rule'], ['probe', '(a) probe'], ['paired', '(a)+(b) probe and pairs'], ...(spec.steps.some((s) => s.metric === 'heap-growth') ? [['slope', '(a)+(b) with the heap slope']] : [])];
const results = rules.map(([rule]) => outcome(rule));
console.log(`TRIAL  ${spec.fixture} ${spec.form} load, ${raw.repeats.length} pairs: ${rules.map(([, name], k) => `${name} ${results[k].status} (clean false positives ${results[k].cleanFp}, decoys ${results[k].decoys}${results[k].missed?.length ? `, missed ${results[k].missed.join(' ')}` : ''})`).join(' | ')}`);
rules.forEach(([, name], k) => { for (const w of results[k].why) console.log(`      ${name}: ${w}`); if (results[k].note) console.log(`      ${name}: ${results[k].note}`); });
process.exit(failed ? 1 : unreliable ? 3 : 0);
