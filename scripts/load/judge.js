// Judges one fixture form's load run (scripts/trace/run.js --load) and writes
// a report/1 per twin. Needs no Docker or k6: it reads raw.json, so a
// recorded run can be judged again.
//
// Each twin is judged against the other, run on the same machine, back to
// back, never against an absolute number (fixtures/PLAN.md): a twin reports
// a finding when it does markedly worse than the other on a defect's step.
// The planted twin should; the clean twin, held to the same test, should
// not. Counts and shares with no time limit in them are exempt from the
// timing rule. A timed relative verdict (latencies, the event loop's longest
// stretch, a late share, the shedding gap) is judged under the relative
// timing rule (lib/timing.js ruleC; docs/decisions.md, Q8): five pairs or more, the
// twins in alternating order; it holds when every pair clears the step's
// threshold, there is no finding when none does, and a mix is info, timing
// unreliable, never failing. Spread and load averages are recorded only. The
// heap slope is gated on the spread of the slopes. A finding that agrees with
// a static finding (check, rule, and the symbol or endpoint) is that
// finding, with load added to its detection.
//
// Usage: node scripts/load/judge.js <form dir> <out dir>
// Exit codes: 0 both twins as expected, 1 not, 3 a planted defect only
// unreliable.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finding, fingerprint } from '../../core/finding.js';
import { report } from '../../core/report.js';
import { validate } from '../../core/schema.js';
import { scan, VERSION } from '../../bin/erlang.js';
import { slopeOf, MIN_POINTS } from '../../lib/trace-judge.js';
import { ruleC, REASON } from '../../lib/timing.js';
import { linkStatic, fmt } from '../../lib/trace-judge.js';
import { exitOnCrash } from '../../lib/crash.js';

exitOnCrash('load judge');

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
const EXEMPT = new Set(['statements', 'rows', 'blocks', 'attempts', 'stub-open', 'connections', 'bytes', 'failed']);
// The verdict of an exempt quantity: recorded like the timing rule's, with
// the load averages kept as information, and always reliable.
const exempt = ({ samples, before, after }) => {
  const xs = samples.filter((x) => Number.isFinite(x));
  const med = xs.length ? median(xs) : null;
  return { reliable: true, exempt: true, reason: null, why: [], samples: xs, median: med, spread: xs.length && med > 0 ? (Math.max(...xs) - Math.min(...xs)) / med : null, before: before ?? null, after: after ?? null };
};
const JUDGE_OF = { rows: 'statements', blocks: 'statements', 'loop-max': 'latency', 'heap-slope': 'memory', 'stub-open': 'inflight', failed: 'pool-errors', connections: 'connection-errors', p99: 'latency', p90: 'latency', median: 'latency', max: 'first-request', 'late-share': 'throughput' };
const METRICS = {
  // Rows the app received, and shared blocks its statements read (hit or
  // read from disk), per request, from pg_stat_statements (L02, L03).
  rows: { what: 'rows read per request', of: (s) => (s.counts.requests ? (s.statements?.rows ?? 0) / s.counts.requests : 0), fmt: (x) => fmt(Math.round(x)) },
  blocks: { what: 'shared blocks read per request', of: (s) => (s.counts.requests ? (s.statements?.blocks ?? 0) / s.counts.requests : 0), fmt: (x) => fmt(Math.round(x)) },
  // The event loop's longest stretch over the step (monitorEventLoopDelay's
  // max, L09): timed.
  'loop-max': { what: 'ms, the event loop\'s longest stretch', of: (s) => s.loop?.maxMs ?? 0, fmt: (x) => String(Math.round(x)) },
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
  // The heap slope (L05): judged in its own branch of the compare judge.
  'heap-slope': { what: 'bytes of heap kept per request (slope)', of: () => 0, fmt: (x) => fmt(Math.round(x)) },
};
const CONTROL_SHARE = 0.9;

// The heap slope (L05; the owner, 19 November 2026): the heap after a full
// collection against the responses answered, fitted by least squares over a
// step's points (MIN_POINTS or more) in each repeat, and judged per pair under
// the relative rule: a pair clears when this twin's slope is positive, at
// least the step's floor and at least ratio times the other twin's in the
// same pair. Every pair, none, or a mix (unreliable); the spread of the slopes
// and each fit's R² are recorded only.
const fit = (points) => slopeOf((points ?? []).map((p) => ({ x: p.answered, y: p.heapUsed })));

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
function judgeTwin(raw, twin) {
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
      // The relative timing rule (docs/decisions.md, Q8): every pair's gap over
      // the bar, none, or a mix (unreliable).
      const c = ruleC({ clears: samples.map((g) => g >= SHED_GAP), samples, before: env.before, after: env.after });
      if (twin === 'planted') MEASURED.push(`step ${id} (goodput gap, clean minus planted, needs ${SHED_GAP}): ${JSON.stringify(samples)}; ${verdictOf(c.timing)}`);
      if (!c.holds) continue;
      const timing = c.timing;
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
      if (step.metric === 'heap-slope') {
        const fits = raw.repeats.map((rep) => ({ me: fit(stepOf(rep, twin, step.id).heap?.points), them: fit(stepOf(rep, other, step.id).heap?.points) }));
        if (twin === 'planted') {
          const fitsOf = (k) => fits.map((f) => (f[k].slope === null ? `none (${f[k].points} point(s))` : `${f[k].slope.toFixed(1)} R² ${f[k].r2.toFixed(2)}`)).join(', ');
          MEASURED.push(`step ${step.id} (heap slope, B/request, needs ${ratio}x and ${step.floor ?? 0}${spec.defects.some((d) => d.step === step.id) ? '' : EXPECTED_MISSES.some((d) => d.step === step.id) ? '; an expected miss' : '; a decoy route'}): planted ${fitsOf('me')}; clean ${fitsOf('them')}`);
        }
        const slopes = fits.map((f) => f.me.slope ?? 0);
        const mineS = median(slopes);
        const theirsS = median(fits.map((f) => f.them.slope ?? 0));
        // Per pair, under the relative rule (the owner, 19 November 2026): a
        // pair clears when this twin's slope, fitted over MIN_POINTS or more
        // readings, is positive, at least the floor, and at least ratio times
        // the other twin's slope in the same pair (a negative or flat slope
        // there is cleared by any positive one). All pairs, none, or a mix
        // (unreliable); the spread of the slopes is recorded only.
        const clears = fits.map((f) => f.me.points >= MIN_POINTS && f.me.slope > 0 && f.me.slope >= (step.floor ?? 0) && f.me.slope >= ratio * (f.them.slope ?? 0));
        const c = ruleC({ clears, samples: slopes, before: env.before, after: env.after });
        if (!c.holds) continue;
        const s0 = stepOf(raw.repeats[0], twin, step.id);
        const timing = { ...c.timing, why: c.timing.why.join('; ') || null, samples: slopes.map((x) => Number(x.toFixed(2))), median: mineS };
        const t = { check: step.check ?? spec.check, rule: step.rule ?? spec.rule, method: s0.method, route: s0.route ?? step.route, symbol: step.symbol ?? null };
        const load = { judge: 'memory', step: step.id, path: s0.path, rate: step.rate, seconds: step.seconds, repeats: fits.length, samples: timing.samples, twin: { 'heap-slope': mineS, r2: fits.map((f) => Number((f.me.r2 ?? 0).toFixed(3))) }, other: { 'heap-slope': theirsS }, timing };
        out.push(emit(t, statics, `At ${fmt(step.rate)} requests a second for ${step.seconds} s, ${t.method} ${t.route} kept about ${fmt(Math.round(mineS))} bytes of heap per request (the least-squares slope of the heap after full collections against responses answered, positive in every repeat), against ${fmt(Math.round(theirsS))} for the twin without the defect (STB-05).${timing.reliable ? '' : ` Not judged: ${REASON} (${timing.why}).`}`, load, timing.reliable ? 'warning' : 'info'));
        continue;
      }
      const clearsOf = (r) => r.me > 0 && r.me >= (step.floor ?? 0) && r.me >= ratio * r.them;
      if (twin === 'planted') {
        const r4 = (xs) => JSON.stringify(xs.map((x) => Number(x.toFixed(4))));
        const v = EXEMPT.has(step.metric) ? exempt({ samples: runs.map((r) => r.me), before: env.before, after: env.after }) : ruleC({ clears: runs.map(clearsOf), samples: runs.map((r) => r.me), before: env.before, after: env.after }).timing;
        MEASURED.push(`step ${step.id} (${step.metric}, needs ${ratio}x and ${step.floor ?? 0}): planted ${r4(runs.map((r) => r.me))}, clean ${r4(runs.map((r) => r.them))}; ${v.exempt ? 'a count or share, exempt from the timing rule; ' : ''}${verdictOf(v)}`);
      }
      const samples = runs.map((r) => Number(r.me.toFixed(4)));
      let timing;
      if (EXEMPT.has(step.metric)) {
        if (!(mine >= (step.floor ?? 0)) || !(mine >= ratio * theirs) || mine === 0) continue;
        timing = exempt({ samples, before: env.before, after: env.after });
      } else {
        // A timed relative verdict (latencies, the loop's longest stretch, a
        // late share): the relative timing rule (docs/decisions.md, Q8), each
        // twin against the other in every pair.
        const c = ruleC({ clears: runs.map(clearsOf), samples, before: env.before, after: env.after });
        if (!c.holds) continue;
        timing = c.timing;
      }
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
  writeFileSync(join(outDir, twin, 'report.json'), JSON.stringify(r, null, 2) + '\n');
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
// Expected misses (load.json "expectedMisses": [{ step, check, rule, floor }]):
// a planted defect below the measure's detection floor, kept and documented
// rather than deleted. The planted twin is not required to report it; if it
// does, the line says so (the floor moved) without failing. The clean twin
// must still report nothing there.
const EXPECTED_MISSES = spec.expectedMisses ?? [];
const expectedMiss = (f) => EXPECTED_MISSES.some((d) => matches(d, f));
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
    const extra = judged.filter((f) => !spec.defects.some((d) => matches(d, f)) && !expectedMiss(f));
    const unlinked = spec.defects.filter((d) => d.linked && judged.some((f) => matches(d, f) && !f.detection.includes('static')));
    const wrong = missing.length || extra.length || unlinked.length;
    say(!wrong && !inconclusive.length, `planted: ${judged.filter((f) => spec.defects.some((d) => matches(d, f))).length}/${spec.defects.length} defects found under load${inconclusive.length ? ` (${inconclusive.length} timing unreliable)` : ''}`,
      [...missing.map((d) => `missed ${d.check} step ${d.step}`), ...extra.map((f) => `decoy reported: ${keyOf(f)}`), ...unlinked.map((d) => `not linked: step ${d.step}`), ...infos.map((f) => `info: ${keyOf(f)}`)].join('; '), wrong ? 'FAIL' : inconclusive.length ? 'UNRELIABLE' : 'PASS');
    for (const d of EXPECTED_MISSES) console.log(`EXPECTED  ${spec.fixture} ${spec.form} load planted: ${d.check} ${d.rule ?? ''} step ${d.step}, below the detection floor (${d.floor}): ${judged.some((f) => matches(d, f)) ? 'found this run all the same' : 'not found, as documented'}`);
    for (const m of MEASURED) console.log(`      measured ${m}`);
    for (const f of extra) console.log(`      ${f.message}`);
  } else {
    say(!judged.length, `clean: ${judged.length} error(s) or warning(s)`, [...judged.map((f) => `reported: ${keyOf(f)}`), ...infos.map((f) => `info: ${keyOf(f)}`)].join('; '));
  }
}
process.exit(failed ? 1 : unreliable ? 3 : 0);
