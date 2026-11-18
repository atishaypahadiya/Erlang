// Judges one fixture form's recorded counts (scripts/trace/run.js) and writes
// a report/1 per twin. Needs no Docker: it reads raw.json, so a recorded run
// can be judged again.
//
// A trace finding that agrees with a static finding (the same check, method
// and route, and a source line of the static finding holding the statement
// that grows) becomes one finding resting on both: the static finding's
// fingerprint, locations and fix, with the counts in erlang.trace
// (research/trace-harness.md, decision 4).
//
// Then the twins are checked against trace.json: the planted twin reports
// exactly its defects as errors or warnings, linked where trace.json says so,
// and the clean twin reports no error or warning. Uncertain and unstable
// results are info, listed but not failing.
//
// Usage: node scripts/trace/judge.js <form dir> <out dir>
// Exit codes: 0 both twins as expected, 1 not.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finding, fingerprint } from '../../core/finding.js';
import { report } from '../../core/report.js';
import { validate } from '../../core/schema.js';
import { scan, VERSION } from '../../bin/erlang.js';
import { growth, rowsGrowth, repeated, linkStatic, normalizeSql, routePattern, fmt, COMPRESS_MIN, UNREAD, ROWS, SLOPE } from '../../lib/trace-judge.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const extensionSchema = JSON.parse(readFileSync(join(ROOT, 'schema', 'finding-erlang.schema.json'), 'utf8'));
const [formDir, outDir] = process.argv.slice(2).map((p) => p && resolve(p));
if (!formDir || !outDir) {
  console.error('usage: node scripts/trace/judge.js <form dir> <out dir>');
  process.exit(64);
}
const spec = JSON.parse(readFileSync(join(formDir, 'trace', 'trace.json'), 'utf8'));
const [LO, HI] = [spec.scales[0], spec.scales.at(-1)];
const TEXT = /json|text|javascript|xml/;

const RULE = { 'n-plus-one': ['DAT-01', 'MUST'], 'per-row-writes': ['DAT-02', 'SHOULD'], 'unbounded-query': ['STB-04', 'MUST'] };
const SEVERITY = { MUST: 'error', SHOULD: 'warning' };
const NOTE = {
  'n-plus-one': 'Read the related rows in one statement: a join in the query the list comes from, or one query with WHERE id = ANY($1) over the ids.',
  'per-row-writes': 'Write the rows in one statement: a multi-row INSERT, or INSERT ... SELECT FROM unnest($1::int[], ...), or UPDATE ... FROM unnest(...).',
  'unbounded-query': 'Bound the read: a LIMIT with a cap the client cannot raise, keyset pagination, or an aggregate computed in the database.',
  'DAT-01': 'Load what the page shows in a fixed number of calls: one endpoint that returns the values for every item shown, not one call per item.',
  'DAT-04': 'Return the fields the page reads; leave the rest to the endpoint of a page that shows them.',
  'DAT-08': 'Compress text responses when the client offers it, with Vary: Accept-Encoding: for Fastify, register @fastify/compress.',
};

// The subject's source, line by line, for linking and for locating a fix.
function sourceOf(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c|m)?(j|t)sx?$/.test(e.name) && statSync(p).size < 1_000_000) files.push([relative(dir, p), readFileSync(p, 'utf8').split('\n')]);
    }
  };
  walk(dir);
  return new Map(files);
}
const locate = (src, test) => [...src].flatMap(([file, lines]) => lines.flatMap((l, k) => (test(l) ? [{ file, line: k + 1 }] : [])));

function judgeTwin(twin) {
  const raw = JSON.parse(readFileSync(join(outDir, twin, 'raw.json'), 'utf8'));
  const subjectDir = join(formDir, twin);
  const src = sourceOf(subjectDir);
  const lineOf = (file, line) => src.get(file)?.[line - 1] ?? null;
  const statics = spec.judge === 'page' ? [] : scan(subjectDir).findings;
  const lo = raw.scales[LO];
  const hi = raw.scales[HI];
  const out = [];
  const seen = new Set();

  function emit({ check, rule, strength, severity, method, route, statement = null, message, trace, unresolved = false }) {
    const t = { check, method, route, statement };
    const s = severity === 'info' ? null : linkStatic(t, statics, lineOf);
    const key = `${check}|${rule}|${method} ${route}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ratio = Number.isFinite(trace.ratio) ? Number(trace.ratio.toFixed(3)) : null;
    const ev = { ...trace, ratio, ...(trace.slope !== undefined && trace.slope !== null ? { slope: Number(trace.slope.toFixed(3)) } : {}) };
    if (s) {
      out.push(finding({
        specialist: 'erlang', check, severity: s.severity, fingerprint: s.fingerprint,
        message: `${s.message} Traced on seeded data: ${message}`,
        detection: [...new Set([...s.detection, 'trace'])], rules: s.rules, where: s.where,
        extension: { ...s.erlang, trace: ev },
      }));
      return;
    }
    const at = statement
      ? locate(src, (l) => normalizeSql(l).includes(normalizeSql(statement)))
      : locate(src, (l) => routePattern(route).test(l));
    const fix = at.length ? { kind: 'guided', locations: at, note: NOTE[rule] ?? NOTE[check] } : null;
    out.push(finding({
      specialist: 'erlang', check, severity, fingerprint: fingerprint(check, `${method} ${route}`, rule, 'trace'),
      message, detection: ['trace'], rules: [rule],
      where: { endpoints: [{ method, route }], ...(at.length ? { locations: at.map((l) => ({ ...l, column: 1 })) } : {}) },
      extension: { strength, ...(unresolved ? { unresolved: true } : {}), ...(fix ? { fix } : {}), trace: ev },
    }));
  }

  const scaleOf = (scale, r, extra = {}) => ({ scale, items: r.items, ...extra });
  for (const r of spec.judge === 'page' ? [] : spec.requests) {
    const a = lo.requests.find((x) => x.id === r.id);
    const b = hi.requests.find((x) => x.id === r.id);
    for (const x of [a, b]) if (x.status >= 400) throw new Error(`${twin}: ${r.method} ${x.path} answered ${x.status}; the fixture or its seed is wrong`);
    const calls = (x) => Object.values(x.statements).reduce((sum, s) => sum + s.calls, 0);
    const rows = (x) => Object.values(x.statements).reduce((sum, s) => sum + s.rows, 0);
    const route = b.route ?? r.path;
    if (!a.stable || !b.stable) {
      const check = spec.judge === 'rows' ? 'unbounded-query' : 'n-plus-one';
      emit({ check, rule: RULE[check][0], strength: RULE[check][1], severity: 'info', unresolved: true, method: r.method, route,
        message: `${r.method} ${route} gave different counts in its two measured runs at ${a.stable ? HI : LO}x, so nothing is judged.`,
        trace: { judge: spec.judge, unstable: true, path: b.path, scales: [scaleOf(LO, a, { statements: calls(a), rows: rows(a) }), scaleOf(HI, b, { statements: calls(b), rows: rows(b) })] } });
      continue;
    }
    if (spec.judge === 'statements') {
      const g = growth({ n1: a.items, n10: b.items, c1: calls(a), c10: calls(b) });
      if (g.verdict === 'fixed') continue;
      const byQuery = {};
      for (const q of new Set([...Object.keys(a.statements), ...Object.keys(b.statements)])) byQuery[q] = { c1: a.statements[q]?.calls ?? 0, c10: b.statements[q]?.calls ?? 0 };
      const stmt = repeated(byQuery);
      const check = /^\s*(insert|update|delete|merge)\b/i.test(stmt.query) ? 'per-row-writes' : 'n-plus-one';
      const [rule, strength] = RULE[check];
      const what = check === 'per-row-writes' ? 'write' : 'statement';
      const counts = `${fmt(calls(a))} statements for ${fmt(a.items ?? 0)} items at ${LO}x, ${fmt(calls(b))} for ${fmt(b.items ?? 0)} at ${HI}x`;
      const trace = { judge: 'statements', slope: g.k, ratio: g.ratio, statement: stmt.query, path: b.path, scales: [scaleOf(LO, a, { statements: calls(a) }), scaleOf(HI, b, { statements: calls(b) })] };
      if (g.verdict === 'grows') emit({ check, rule, strength, severity: SEVERITY[strength], method: r.method, route, statement: stmt.query, trace,
        message: `${r.method} ${route} sends one more ${what} per item: ${counts} (${fmt(g.k)} per item). The ${what} that repeats: ${stmt.query}. Counted with pg_stat_statements (DAT-07).` });
      else emit({ check, rule, strength, severity: 'info', unresolved: true, method: r.method, route, statement: stmt.query, trace,
        message: `${r.method} ${route} sends more statements at ${HI}x (${counts}), but fewer than ${fmt(SLOPE)} per extra item: neither a fixed count nor one per item. The statement that grows most: ${stmt.query}.` });
    } else {
      const g = rowsGrowth({ r1: rows(a), r10: rows(b) });
      if (g.verdict === 'bounded') continue;
      const top = Object.entries(b.statements).sort((x, y) => y[1].rows - x[1].rows || (x[0] < y[0] ? -1 : 1))[0]?.[0] ?? '';
      const [rule, strength] = RULE['unbounded-query'];
      const counts = `${fmt(rows(a))} rows at ${LO}x and ${fmt(rows(b))} at ${HI}x`;
      const trace = { judge: 'rows', ratio: g.ratio, statement: top, path: b.path, streamed: b.streamed, scales: [scaleOf(LO, a, { rows: rows(a) }), scaleOf(HI, b, { rows: rows(b) })] };
      if (g.verdict === 'grows' && !b.streamed) emit({ check: 'unbounded-query', rule, strength, severity: SEVERITY[strength], method: r.method, route, statement: top, trace,
        message: `${r.method} ${route} reads ${counts}: the read grows with the table (${fmt(g.ratio)} times). The statement: ${top}. Counted with pg_stat_statements (DAT-07).` });
      else emit({ check: 'unbounded-query', rule, strength, severity: 'info', unresolved: true, method: r.method, route, statement: top, trace,
        message: b.streamed
          ? `${r.method} ${route} reads ${counts}, but streams its response: counts cannot tell whether the rows are held in memory at once.`
          : `${r.method} ${route} reads ${counts}: more at ${HI}x, but less than ${ROWS} times as many.` });
    }
  }

  for (const p of spec.judge === 'page' ? spec.pages : []) {
    const a = lo.pages.find((x) => x.id === p.id);
    const b = hi.pages.find((x) => x.id === p.id);
    for (const x of [...a.calls, ...b.calls]) if (x.status >= 400) throw new Error(`${twin}: ${x.method} ${x.path} answered ${x.status} in page ${p.id}`);
    const g = growth({ n1: a.items, n10: b.items, c1: a.calls.length, c10: b.calls.length });
    if (g.verdict !== 'fixed') {
      const per = (x) => x.calls.reduce((m, c) => m.set(c.route, (m.get(c.route) ?? 0) + 1), new Map());
      const pa = per(a);
      const pb = per(b);
      const route = [...pb.keys()].sort().reduce((best, k) => ((pb.get(k) - (pa.get(k) ?? 0)) > (pb.get(best) - (pa.get(best) ?? 0)) ? k : best));
      const counts = `${a.calls.length} calls for ${a.items} items at ${LO}x, ${b.calls.length} for ${b.items} at ${HI}x`;
      emit({ check: 'oversized-payload', rule: 'DAT-01', strength: 'MUST', severity: g.verdict === 'grows' ? 'error' : 'info', unresolved: g.verdict !== 'grows', method: 'GET', route,
        trace: { judge: 'calls', page: p.id, slope: g.k, ratio: g.ratio, scales: [{ scale: LO, items: a.items, calls: a.calls.length }, { scale: HI, items: b.items, calls: b.calls.length }] },
        message: g.verdict === 'grows'
          ? `The ${p.id} page view makes one more call per item it shows: ${counts}. The call that repeats: GET ${route}.`
          : `The ${p.id} page view makes more calls at ${HI}x (${counts}), but fewer than one per extra item.` });
    }
    const byRoute = new Map();
    for (const c of b.calls) byRoute.set(c.route, [...(byRoute.get(c.route) ?? []), c]);
    for (const [route, cs] of [...byRoute].sort(([x], [y]) => (x < y ? -1 : 1))) {
      const plain = cs.filter((c) => !c.encoding && c.bytes >= COMPRESS_MIN && TEXT.test(c.contentType ?? ''));
      if (plain.length) {
        const big = plain.reduce((m, c) => (c.bytes > m.bytes ? c : m));
        emit({ check: 'oversized-payload', rule: 'DAT-08', strength: 'SHOULD', severity: 'warning', method: 'GET', route,
          trace: { judge: 'bytes', page: p.id, path: big.path, encoding: null, scales: [{ scale: HI, bytes: big.bytes }] },
          message: `GET ${route} sent ${fmt(big.bytes)} bytes of ${big.contentType.split(';')[0]} with no Content-Encoding, though the request offered gzip and br (${p.id} page view, ${HI}x).` });
      }
      const json = cs.reduce((s, c) => s + c.jsonBytes, 0);
      const unread = cs.reduce((s, c) => s + c.unreadBytes, 0);
      if (json >= COMPRESS_MIN && unread / json >= UNREAD) {
        const fields = [...new Set(cs.flatMap((c) => c.unreadFields))].sort();
        emit({ check: 'oversized-payload', rule: 'DAT-04', strength: 'SHOULD', severity: 'warning', method: 'GET', route,
          trace: { judge: 'fields', page: p.id, unreadFields: fields, scales: [{ scale: HI, jsonBytes: json, unreadBytes: unread }] },
          message: `The ${p.id} page view never reads ${fields.join(', ')} from GET ${route}: ${fmt(unread)} of its ${fmt(json)} bytes of JSON (${(Math.floor((1000 * unread) / json) / 10).toFixed(1)}%, ${HI}x).` });
      }
    }
  }

  for (const f of out) {
    const errors = validate(extensionSchema, f.erlang);
    if (errors.length) throw new Error(`${twin}: ${f.fingerprint}: erlang extension: ${errors.join('; ')}`);
  }
  const r = report({
    specialist: 'erlang', version: VERSION, subject: relative(process.cwd(), subjectDir) || '.', started: new Date(raw.started ?? Date.now()),
    findings: out,
    run: { trace: { image: raw.image, fixture: raw.fixture, form: raw.form, twin, judge: spec.judge, seed: raw.seed, scales: Object.fromEntries(Object.entries(raw.scales).map(([k, v]) => [k, { n: v.n, tables: v.tables }])) } },
  });
  writeFileSync(join(outDir, twin, 'report.json'), JSON.stringify(r, null, 2) + '\n');
  return r;
}

const keyOf = (f) => `${f.check} ${f.rules?.[0] ?? ''} ${(f.where.endpoints ?? []).map((e) => `${e.method} ${e.route}`).join(',')}`;
const matches = (d, f) => d.check === f.check && (!d.rule || f.rules?.includes(d.rule)) && (f.where.endpoints ?? []).some((e) => e.method === d.method && e.route === d.route);
let failed = false;
const say = (ok, what, detail) => { if (!ok) failed = true; console.log(`${ok ? 'PASS' : 'FAIL'}  ${spec.fixture} ${spec.form} ${what}${detail ? `  (${detail})` : ''}`); };
for (const twin of ['planted', 'clean']) {
  if (!existsSync(join(outDir, twin, 'raw.json'))) { say(false, twin, 'no raw.json: run scripts/trace.sh'); continue; }
  const r = judgeTwin(twin);
  const judged = r.findings.filter((f) => f.severity !== 'info');
  const infos = r.findings.filter((f) => f.severity === 'info').map(keyOf);
  if (twin === 'planted') {
    const missing = spec.defects.filter((d) => !judged.some((f) => matches(d, f)));
    const extra = judged.filter((f) => !spec.defects.some((d) => matches(d, f)));
    const unlinked = spec.defects.filter((d) => d.linked && judged.some((f) => matches(d, f) && !f.detection.includes('static')));
    say(!missing.length && !extra.length && !unlinked.length, `planted: ${judged.length - extra.length}/${spec.defects.length} defects traced${spec.defects.some((d) => d.linked) ? `, ${spec.defects.filter((d) => d.linked).length - unlinked.length} linked to a static finding` : ''}`,
      [...missing.map((d) => `missed ${d.check} ${d.rule ?? ''} ${d.method} ${d.route}`), ...extra.map((f) => `decoy reported: ${keyOf(f)}`), ...unlinked.map((d) => `not linked: ${d.method} ${d.route}`), ...infos.map((i) => `info: ${i}`)].join('; '));
  } else {
    say(!judged.length, `clean: ${judged.length} error(s) or warning(s)`, [...judged.map((f) => `reported: ${keyOf(f)}`), ...infos.map((i) => `info: ${i}`)].join('; '));
  }
}
process.exit(failed ? 1 : 0);
