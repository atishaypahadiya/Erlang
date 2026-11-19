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
const JUDGE_OF = { 'stub-open': 'inflight', failed: 'pool-errors', connections: 'connection-errors', p99: 'latency', median: 'latency', max: 'first-request', 'late-share': 'throughput', 'heap-growth': 'memory' };
const METRICS = {
  statements: { what: 'statements per request', of: (s) => (s.counts.requests ? (s.statements?.calls ?? 0) / s.counts.requests : 0), fmt: (x) => x.toFixed(1) },
  attempts: { what: 'calls to the failing host per request', of: (s, step) => (offered(s) ? (s.upstream ?? []).filter((u) => u.host === step.host).reduce((a, u) => a + u.calls, 0) / offered(s) : 0), fmt: (x) => x.toFixed(1) },
  failed: { what: 'share of requests that failed', of: (s) => (offered(s) ? s.counts.failed / offered(s) : 0), fmt: pct },
  'stub-open': { what: 'calls held open at the hanging host, at most', of: (s) => Math.max(0, ...s.samples.map((x) => (Number.isFinite(x['stub-open']) ? x['stub-open'] : 0))), fmt: (x) => String(Math.round(x)) },
  connections: { what: 'connections open at the database, at most', of: (s) => Math.max(0, ...s.samples.map((x) => (Number.isFinite(x.connections) ? x.connections : 0))), fmt: (x) => String(Math.round(x)) },
  p99: { what: 'p99 latency of the requests served, in ms', of: (s) => s.served?.p99Ms ?? 0, fmt: (x) => String(Math.round(x)) },
  median: { what: 'median latency of the requests served, in ms', of: (s) => s.served?.medMs ?? 0, fmt: (x) => x.toFixed(1) },
  max: { what: 'slowest response, in ms', of: (s) => s.served?.maxMs ?? 0, fmt: (x) => String(Math.round(x)) },
  // Bytes on the wire per request (k6's data_received, headers included,
  // compressed as sent), for a step with no background.
  bytes: { what: 'bytes on the wire per response', of: (s) => (s.counts.requests ? (s.counts.wireBytes ?? 0) / s.counts.requests : 0), fmt: (x) => fmt(Math.round(x)) },
  'late-share': { what: 'share of requests not answered in time', of: (s) => (offered(s) ? 1 - s.counts.ok / offered(s) : 0), fmt: pct },
  'heap-growth': { what: 'bytes of heap kept per request, after a full collection', of: (s) => (s.heap?.after != null && s.counts.requests ? Math.max(0, (s.heap.after - s.heap.before) / s.counts.requests) : 0), fmt: (x) => fmt(Math.round(x)) },
};
const CONTROL_SHARE = 0.9;

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
    return !w || load > w.load1 ? { load1: load, cpus: x.cpus } : w;
  }, null);
  return { before: worst('before'), after: worst('after') };
}

function judgeTwin(raw, twin) {
  const other = twin === 'planted' ? 'clean' : 'planted';
  const subjectDir = join(formDir, twin);
  const statics = scan(subjectDir).findings;
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
      if (gap < SHED_GAP) continue;
      const timing = timingJudge({ samples, before: env.before, after: env.after });
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
      if (!(mine >= (step.floor ?? 0)) || !(mine >= ratio * theirs) || mine === 0) continue;
      const samples = runs.map((r) => Number(r.me.toFixed(4)));
      const timing = timingJudge({ samples, before: env.before, after: env.after });
      const s0 = stepOf(raw.repeats[0], twin, step.id);
      const t = { check: step.check ?? spec.check, rule: step.rule ?? spec.rule, method: s0.method, route: s0.route ?? step.route, symbol: step.symbol ?? null };
      const load = { judge: JUDGE_OF[step.metric] ?? step.metric, step: step.id, path: s0.path, rate: step.rate, seconds: step.seconds, repeats: runs.length, samples, twin: { [step.metric]: mine }, other: { [step.metric]: theirs }, timing: { ...timing, why: Array.isArray(timing.why) ? (timing.why.join('; ') || null) : timing.why ?? null } };
      const message = `At ${fmt(step.rate)} requests a second for ${step.seconds} s${step.host ? `, with ${step.host} failing` : ''}, ${t.method} ${t.route} showed ${m.fmt(mine)} ${m.what}, against ${m.fmt(theirs)} for the twin without the defect (${step.because ?? t.rule}). Measured with k6 at a fixed arrival rate, ${runs.length} repeats.${timing.reliable ? '' : ` Not judged: ${REASON} (${load.timing.why}).`}`;
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
    return finding({
      specialist: 'erlang', check: t.check, severity: s.severity, fingerprint: s.fingerprint,
      message: `${s.message} Under load: ${message}`,
      detection: [...new Set([...s.detection, 'load'])], rules: s.rules, where: s.where,
      extension: { ...s.erlang, load },
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
let failed = false;
const say = (ok, what, detail) => { if (!ok) failed = true; console.log(`${ok ? 'PASS' : 'FAIL'}  ${spec.fixture} ${spec.form} load ${what}${detail ? `  (${detail})` : ''}`); };
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
    for (const d of inconclusive) console.log(`SKIP  ${spec.fixture} ${spec.form} load planted: ${d.check} ${d.rule ?? ''} step ${d.step}: ${REASON}, so not judged`);
    const missing = spec.defects.filter((d) => !judged.some((f) => matches(d, f)) && !inconclusive.includes(d));
    const extra = judged.filter((f) => !spec.defects.some((d) => matches(d, f)));
    const unlinked = spec.defects.filter((d) => d.linked && judged.some((f) => matches(d, f) && !f.detection.includes('static')));
    say(!missing.length && !extra.length && !unlinked.length, `planted: ${judged.length - extra.length}/${spec.defects.length - inconclusive.length} defects found under load${inconclusive.length ? ` (${inconclusive.length} timing unreliable)` : ''}`,
      [...missing.map((d) => `missed ${d.check} step ${d.step}`), ...extra.map((f) => `decoy reported: ${keyOf(f)}`), ...unlinked.map((d) => `not linked: step ${d.step}`), ...infos.map((f) => `info: ${keyOf(f)}`)].join('; '));
  } else {
    say(!judged.length, `clean: ${judged.length} error(s) or warning(s)`, [...judged.map((f) => `reported: ${keyOf(f)}`), ...infos.map((f) => `info: ${keyOf(f)}`)].join('; '));
  }
}
process.exit(failed ? 1 : 0);
