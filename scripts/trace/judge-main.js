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

import { defectMatches } from '../../lib/trace-judge.js';
import { decoyMargin, plantedMargin } from '../../lib/margin.js';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finding, fingerprint } from '../../core/finding.js';
import { report } from '../../core/report.js';
import { validate } from '../../core/schema.js';
import { scan, VERSION } from '../../lib/erlang.js';
import { ruleC, environment, REASON, waitVerdict, TIMED_TRACE_JUDGES } from '../../lib/timing.js';

const median_ = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
import { growth, rowsGrowth, repeated, linkStatic, normalizeSql, routePattern, fmt, COMPRESS_MIN, UNREAD, ROWS, SLOPE, slopeOf, MIN_POINTS } from '../../lib/trace-judge.js';
import { exitOnCrash } from '../../lib/crash.js';
import { text, measured as M, declared as D, plain as plainText, asText, measuredPaths } from '../../lib/values.js';

exitOnCrash('trace judge');

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
const NO_WAIT_MS = 20;
// RTY-01: still retrying when the harness gave up, with at least this many
// attempts in every run.
const MIN_ATTEMPTS = 3;
const RULE_TMO = 'TMO-01';
// judge "loop": a request blocks the loop when the longest stretch the loop
// could not run is at least BLOCK_MS and at least BLOCK_SHARE of the
// request's own time, in every judged run.
const BLOCK_MS = 50;
const BLOCK_SHARE = 0.7;
// judge "cache": a read repeated across requests counts when its cost grows
// with the table (blocks per call at the top scale over the bottom one) and
// its result does not (rows per call): an aggregate, not a list.
// A Cache-Control that lets a client or proxy reuse the response: max-age or
// s-maxage above 0, and neither no-store nor no-cache.
const fresh = (cc) => !!cc && !/\b(no-store|no-cache)\b/i.test(cc) && /\b(s-)?max-age=0*[1-9]/i.test(cc);
const COST_RATIO = 5;
// judge "memory": heap kept per request, after a full collection: the
// least-squares slope over the soak's points from its first count on (past
// every bound a fixed version sets). The rule a real project gets, with no
// twin to compare against, and the one the fixtures use (the owner, 19
// November 2026): a positive slope of at least KEPT_BYTES a request with a
// fit of at least MIN_FIT (R²). Below MIN_FIT the slope is the collector's
// noise, whatever its size (CI run 44666936253: 45 and 97 bytes a request on
// fits of 0.22 and 0.06). Below KEPT_BYTES it may be what a live process
// keeps anyway: code compiled late, caches still settling (37 bytes a request
// with R² 0.96 on L05's bounded suggestion cache; a clean twin's own retention
// up to 281 bytes a request on a short stretch, CI run 44609939663). A leak
// smaller than that is not detected (L05's POST /orders, about 83 to 128
// bytes an order, the documented expected miss).
const KEPT_BYTES = 512;
const MIN_FIT = 0.9;
// judge "plans": a sequential scan with a filter, on a table of BIG_TABLE
// rows or more, returning under SELECTIVE of the rows it read.
const BIG_TABLE = 10_000;
const SELECTIVE = 0.05;
// judge "starts".
const FIRST_EXTRA_MS = 20;
const FIRST_RATIO = 3;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const READ = /^\s*(?:select|with)\b/i;
const WRITE = /^\s*(?:insert|update|delete|merge|truncate|refresh)\b/i;

const RULE = { 'n-plus-one': ['DAT-01', 'MUST'], 'per-row-writes': ['DAT-02', 'SHOULD'], 'unbounded-query': ['STB-04', 'MUST'] };
const COUNT_JUDGES = new Set(['statements', 'rows']);
const SEVERITY = { MUST: 'error', SHOULD: 'warning' };
const NOTE = {
  'n-plus-one': 'Read the related rows in one statement: a join in the query the list comes from, or one query with WHERE id = ANY($1) over the ids.',
  'per-row-writes': 'Write the rows in one statement: a multi-row INSERT, or INSERT ... SELECT FROM unnest($1::int[], ...), or UPDATE ... FROM unnest(...).',
  'unbounded-query': 'Bound the read: a LIMIT with a cap the client cannot raise, keyset pagination, or an aggregate computed in the database.',
  'DAT-01': 'Load what the page shows in a fixed number of calls: one endpoint that returns the values for every item shown, not one call per item.',
  'DAT-04': 'Return the fields the page reads; leave the rest to the endpoint of a page that shows them.',
  'DAT-08': 'Compress text responses when the client offers it, with Vary: Accept-Encoding: for Fastify, register @fastify/compress.',
  'RTY-01': 'Cap the attempts: three in all, then fail with the last error.',
  'RTY-03': 'Wait before each retry, a random time up to a cap that doubles with each attempt (full jitter): Math.random() * Math.min(10_000, 100 * 2 ** attempt) ms.',
  'RTY-06': 'Give up at once on 4xx replies other than 408 and 429; retry network errors, 429 and 5xx only.',
  'STB-08': 'Release the connection in finally, so every path returns it.',
  'OVL-12': 'Use the asynchronous form, which runs on the thread pool (crypto.pbkdf2, zlib.gzip, fs.promises), or move the work to a worker thread.',
  'CAP-08': 'Make the pool once per process, at module level, and use it in every request.',
  'DAT-06': 'Keep the result: read it once per request, or cache it for as long as it may be stale, bounded in entries, with Cache-Control on the response.',
  'STB-05': 'Bound the collection: an LRU with a maximum of entries and an age (lru-cache), or delete entries when they are done with.',
  'STB-10': 'Build the value when the module loads (a top-level await), so the service listens only once it is ready.',
  'DAT-07': 'Add an index on the filtered columns, in a migration: CREATE INDEX CONCURRENTLY in production, outside a transaction.',
  'TMO-01': 'Give the call a deadline: a signal (AbortSignal.timeout(ms)), a timeout option the client enforces, or statement_timeout for PostgreSQL.',
  'STB-09': 'Make the call to the other service before taking the connection, or after returning it.',
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
  const subjectDir = join(spec.twins ? resolve(formDir, spec.twins) : formDir, twin);
  const src = sourceOf(subjectDir);
  const lineOf = (file, line) => src.get(file)?.[line - 1] ?? null;
  const statics = spec.judge === 'page' ? [] : scan(subjectDir).findings;
  const lo = raw.scales[LO];
  const hi = raw.scales[HI];
  const out = [];
  const seen = new Set();

  function emit({ check, rule, strength, severity, method, route, statement = null, message, trace, unresolved = false, symbol = null }) {
    const t = { check, rule, method, route, statement, symbol };
    const s = severity === 'info' ? null : linkStatic(t, statics, lineOf);
    const key = `${check}|${rule}|${method} ${route}|${trace.host ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ratio = Number.isFinite(trace.ratio) ? Number(trace.ratio.toFixed(3)) : null;
    const ev = { ...trace, ratio, ...(trace.slope !== undefined && trace.slope !== null ? { slope: Number(trace.slope.toFixed(3)) } : {}) };
    // The message, its template and its values (lib/values.js).
    const said = asText(message);
    if (s) {
      // A static finding left at info because reading could not decide
      // (unresolved) takes the trace's severity: the trace decided it.
      const resolves = s.severity === 'info' && s.erlang?.unresolved && severity !== 'info';
      const { unresolved: _u, ...ext } = s.erlang ?? {};
      const full = text`${plainText(s.message)} Traced on seeded data: ${said}`;
      out.push(finding({
        specialist: 'erlang', check, severity: resolves ? severity : s.severity, fingerprint: s.fingerprint,
        message: full.message, measured: measuredPaths(full, 'trace', ev),
        detection: [...new Set([...s.detection, 'trace'])], rules: s.rules, where: s.where,
        extension: { ...(resolves ? ext : s.erlang), trace: ev, values: full.values, template: full.template },
      }));
      return;
    }
    const at = statement
      ? locate(src, (l) => normalizeSql(l).includes(normalizeSql(statement)))
      : locate(src, (l) => routePattern(route).test(l));
    const note = NOTE[rule] ?? NOTE[check];
    const fix = at.length && note ? { kind: 'guided', locations: at, note } : null;
    out.push(finding({
      specialist: 'erlang', check, severity, fingerprint: fingerprint(check, `${method} ${route}`, rule, ...(trace.host ? [trace.host] : []), 'trace'),
      message: said.message, measured: measuredPaths(said, 'trace', ev), detection: ['trace'], rules: [rule],
      where: { endpoints: [{ method, route }], ...(at.length ? { locations: at.map((l) => ({ ...l, column: 1 })) } : {}) },
      extension: { strength, ...(unresolved ? { unresolved: true } : {}), ...(fix ? { fix } : {}), trace: ev, values: said.values, template: said.template },
    }));
  }

  const scaleOf = (scale, r, extra = {}) => ({ scale, items: r.items, ...extra });
  for (const r of COUNT_JUDGES.has(spec.judge) ? spec.requests : []) {
    const a = lo.requests.find((x) => x.id === r.id);
    const b = hi.requests.find((x) => x.id === r.id);
    for (const x of [a, b]) if (x.status >= 400) throw new Error(`${twin}: ${r.method} ${x.path} answered ${x.status}; the fixture or its seed is wrong`);
    const calls = (x) => Object.values(x.statements).reduce((sum, s) => sum + s.calls, 0);
    const rows = (x) => Object.values(x.statements).reduce((sum, s) => sum + s.rows, 0);
    const route = b.route ?? r.path;
    if (!a.stable || !b.stable) {
      const check = spec.judge === 'rows' ? 'unbounded-query' : 'n-plus-one';
      emit({ check, rule: RULE[check][0], strength: RULE[check][1], severity: 'info', unresolved: true, method: r.method, route,
        message: text`${r.method} ${route} gave different counts in its two measured runs at ${D('scale', a.stable ? HI : LO)}x, so nothing is judged.`,
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
      const counts = text`${M('statements', calls(a), fmt(calls(a)))} statements for ${D('items', a.items ?? 0, fmt(a.items ?? 0))} items at ${D('scale', LO)}x, ${M('statements', calls(b), fmt(calls(b)))} for ${D('items', b.items ?? 0, fmt(b.items ?? 0))} at ${D('scale', HI)}x`;
      const trace = { judge: 'statements', slope: g.k, ratio: g.ratio, statement: stmt.query, path: b.path, scales: [scaleOf(LO, a, { statements: calls(a) }), scaleOf(HI, b, { statements: calls(b) })] };
      if (g.verdict === 'grows') emit({ check, rule, strength, severity: SEVERITY[strength], method: r.method, route, statement: stmt.query, trace,
        message: text`${r.method} ${route} sends one more ${what} per item: ${counts} (${M('perItem', g.k, fmt(g.k))} per item). The ${what} that repeats: ${stmt.query}. Counted with pg_stat_statements (DAT-07).` });
      else emit({ check, rule, strength, severity: 'info', unresolved: true, method: r.method, route, statement: stmt.query, trace,
        message: text`${r.method} ${route} sends more statements at ${D('scale', HI)}x (${counts}), but fewer than ${D('perItem', SLOPE, fmt(SLOPE))} per extra item: neither a fixed count nor one per item. The statement that grows most: ${stmt.query}.` });
    } else {
      const g = rowsGrowth({ r1: rows(a), r10: rows(b) });
      if (g.verdict === 'bounded') continue;
      const top = Object.entries(b.statements).sort((x, y) => y[1].rows - x[1].rows || (x[0] < y[0] ? -1 : 1))[0]?.[0] ?? '';
      const [rule, strength] = RULE['unbounded-query'];
      const counts = text`${M('rows', rows(a), fmt(rows(a)))} rows at ${D('scale', LO)}x and ${M('rows', rows(b), fmt(rows(b)))} at ${D('scale', HI)}x`;
      const trace = { judge: 'rows', ratio: g.ratio, statement: top, path: b.path, streamed: b.streamed, scales: [scaleOf(LO, a, { rows: rows(a) }), scaleOf(HI, b, { rows: rows(b) })] };
      if (g.verdict === 'grows' && !b.streamed) emit({ check: 'unbounded-query', rule, strength, severity: SEVERITY[strength], method: r.method, route, statement: top, trace,
        message: text`${r.method} ${route} reads ${counts}: the read grows with the table (${M('ratio', g.ratio, fmt(g.ratio))} times). The statement: ${top}. Counted with pg_stat_statements (DAT-07).` });
      else emit({ check: 'unbounded-query', rule, strength, severity: 'info', unresolved: true, method: r.method, route, statement: top, trace,
        message: b.streamed
          ? text`${r.method} ${route} reads ${counts}, but streams its response: counts cannot tell whether the rows are held in memory at once.`
          : text`${r.method} ${route} reads ${counts}: more at ${D('scale', HI)}x, but less than ${D('ratio', ROWS)} times as many.` });
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
      const counts = text`${M('calls', a.calls.length)} calls for ${D('items', a.items)} items at ${D('scale', LO)}x, ${M('calls', b.calls.length)} for ${D('items', b.items)} at ${D('scale', HI)}x`;
      emit({ check: 'oversized-payload', rule: 'DAT-01', strength: 'MUST', severity: g.verdict === 'grows' ? 'error' : 'info', unresolved: g.verdict !== 'grows', method: 'GET', route,
        trace: { judge: 'calls', page: p.id, slope: g.k, ratio: g.ratio, scales: [{ scale: LO, items: a.items, calls: a.calls.length }, { scale: HI, items: b.items, calls: b.calls.length }] },
        message: g.verdict === 'grows'
          ? text`The ${p.id} page view makes one more call per item it shows: ${counts}. The call that repeats: GET ${route}.`
          : text`The ${p.id} page view makes more calls at ${D('scale', HI)}x (${counts}), but fewer than one per extra item.` });
    }
    const byRoute = new Map();
    for (const c of b.calls) byRoute.set(c.route, [...(byRoute.get(c.route) ?? []), c]);
    for (const [route, cs] of [...byRoute].sort(([x], [y]) => (x < y ? -1 : 1))) {
      const plain = cs.filter((c) => !c.encoding && c.bytes >= COMPRESS_MIN && TEXT.test(c.contentType ?? ''));
      if (plain.length) {
        const big = plain.reduce((m, c) => (c.bytes > m.bytes ? c : m));
        emit({ check: 'oversized-payload', rule: 'DAT-08', strength: 'SHOULD', severity: 'warning', method: 'GET', route,
          trace: { judge: 'bytes', page: p.id, path: big.path, encoding: null, scales: [{ scale: HI, bytes: big.bytes }] },
          message: text`GET ${route} sent ${M('bytes', big.bytes, fmt(big.bytes))} bytes of ${big.contentType.split(';')[0]} with no Content-Encoding, though the request offered gzip and br (${p.id} page view, ${D('scale', HI)}x).` });
      }
      const json = cs.reduce((s, c) => s + c.jsonBytes, 0);
      const unread = cs.reduce((s, c) => s + c.unreadBytes, 0);
      if (json >= COMPRESS_MIN && unread / json >= UNREAD) {
        const fields = [...new Set(cs.flatMap((c) => c.unreadFields))].sort();
        emit({ check: 'oversized-payload', rule: 'DAT-04', strength: 'SHOULD', severity: 'warning', method: 'GET', route,
          trace: { judge: 'fields', page: p.id, unreadFields: fields, scales: [{ scale: HI, jsonBytes: json, unreadBytes: unread }] },
          message: text`The ${p.id} page view never reads ${fields.join(', ')} from GET ${route}: ${M('unreadBytes', unread, fmt(unread))} of its ${M('jsonBytes', json, fmt(json))} bytes of JSON (${M('unreadShare', Math.floor((1000 * unread) / json) / 1000, (Math.floor((1000 * unread) / json) / 10).toFixed(1))}%, ${D('scale', HI)}x).` });
      }
    }
  }

  // ---- Pool connections held (judge "pool", L08): checked out while the
  // stub answers an outbound call (STB-09), or still checked out after the
  // response (STB-08). Counts from the twin's own pool, at the top scale.
  for (const r of spec.judge === 'pool' ? spec.requests : []) {
    const x = hi.requests.find((q) => q.id === r.id);
    if (!r.expect && (x.status ?? 500) >= 400) throw new Error(`${twin}: ${r.method} ${x.path} answered ${x.status}; the fixture or its seed is wrong`);
    const route = x.route ?? r.path;
    const runs = [x, x.first ?? x.other].filter(Boolean);
    if ((r.probes ?? []).includes('pool-during')) {
      const during = (q) => Math.max(0, ...(q.upstream ?? []).map((h) => (h.probe?.total ?? 0) - (h.probe?.idle ?? 0)));
      if (!(x.upstream ?? []).length) throw new Error(`${twin}: ${r.method} ${x.path} made no outbound call, so nothing was held across one`);
      const held = during(x);
      const trace = { judge: 'pool', path: x.path, scales: [{ scale: HI, checkedOutDuringCall: held }] };
      if (held >= 1 && x.stable) emit({ check: 'pool-exhaustion', rule: 'STB-09', strength: 'SHOULD', severity: 'warning', method: r.method, route, trace,
        message: text`${r.method} ${route} had ${M('held', held, `${held} pooled connection${held === 1 ? '' : 's'}`)} checked out while its outbound call (${x.upstream[0].method} ${x.upstream[0].host}${x.upstream[0].path}) was answered: the connection waits on the other service (STB-09). Counted from the twin's pool.` });
      else if (held >= 1) emit({ check: 'pool-exhaustion', rule: 'STB-09', strength: 'SHOULD', severity: 'info', unresolved: true, method: r.method, route, trace, message: `${r.method} ${route} held a connection across its outbound call in one run but not the other.` });
    }
    if ((r.probes ?? []).includes('pool-after')) {
      const kept = (q) => (q.poolAfter.total - q.poolAfter.idle) - (q.poolBefore.total - q.poolBefore.idle);
      const ks = runs.map(kept);
      const trace = { judge: 'pool', path: x.path, scales: [{ scale: HI, keptAfterResponse: ks[0] }] };
      if (ks.every((k) => k >= 1)) emit({ check: 'pool-exhaustion', rule: 'STB-08', strength: 'MUST', severity: 'error', method: r.method, route, trace,
        message: text`${r.method} ${route}${x.status >= 400 ? `, answering ${x.status},` : ''} left ${M('kept', ks[0], `${ks[0]} pooled connection${ks[0] === 1 ? '' : 's'}`)} checked out after its response: the connection is never released on that path, and the pool runs out after as many such requests as it holds (STB-08). Counted from the twin's pool.` });
      else if (ks.some((k) => k >= 1)) emit({ check: 'pool-exhaustion', rule: 'STB-08', strength: 'MUST', severity: 'info', unresolved: true, method: r.method, route, trace, message: `${r.method} ${route} kept a connection after its response in one run but not the other.` });
    }
  }

  // ---- Attempts per request (judge "attempts", L06): outbound calls the
  // stub received for one user request, per host, with the stub failing
  // only that host. RTY-01: still retrying when the harness gave up.
  // RTY-03: no wait (every gap under NO_WAIT_MS), or the same wait every
  // time (every declared delay alike: no jitter). RTY-06: a reply
  // that cannot succeed (4xx) retried.
  for (const r of spec.judge === 'attempts' ? spec.requests : []) {
    const x = hi.requests.find((q) => q.id === r.id);
    const route = x.route ?? r.route ?? r.path;
    const failing = Object.entries(r.upstream?.hosts ?? {}).filter(([, a]) => a.status >= 400 || a.hang).map(([h, a]) => [h, a.status]);
    const runs = [x, x.first ?? x.other].filter(Boolean);
    for (const [host, status] of failing) {
      const symbol = spec.hosts?.[host] ?? null;
      // A retry repeats the same request: the attempts are the hits of the
      // host's most repeated method and path (one call per item is not a retry).
      const hitsOf = (q) => {
        const by = new Map();
        for (const h of (q.upstream ?? []).filter((u) => u.host === host)) { const k = `${h.method} ${h.path}`; by.set(k, [...(by.get(k) ?? []), h]); }
        return [...by.values()].sort((a, b) => b.length - a.length)[0] ?? [];
      };
      const attempts = runs.map((q) => hitsOf(q).length);
      const gapsOf = (q) => { const t = hitsOf(q).map((h) => h.at); return t.slice(1).map((v, k) => v - t[k]); };
      const base = { judge: 'attempts', host, path: x.path, scales: [{ scale: HI, attempts: attempts[0], timedOut: !!x.timedOut }] };
      if (runs.every((q) => q.timedOut) && attempts.every((a) => a >= MIN_ATTEMPTS)) {
        emit({ check: 'retry-policy', rule: 'RTY-01', strength: 'MUST', severity: 'error', method: r.method, route, symbol, trace: base,
          message: text`${r.method} ${route} was still retrying ${host} when the harness gave up after ${D('timeoutMs', r.timeoutMs, fmt(r.timeoutMs))} ms: ${M('attempts', attempts[0])} attempts so far, at least ${D('minAttempts', MIN_ATTEMPTS)} in every run, with the stub failing every one (${status}). Nothing caps the attempts (RTY-01).` });
        continue;
      }
      if (status >= 400 && status < 500 && ![408, 429].includes(status)) {
        if (attempts.every((a) => a > 1)) emit({ check: 'retry-policy', rule: 'RTY-06', strength: 'MUST', severity: 'warning', method: r.method, route, symbol, trace: base,
          message: text`${r.method} ${route} sent ${M('attempts', attempts[0])} requests to ${host} for one user request, though the first was answered ${status}, a reply that cannot succeed when sent again (RTY-06).` });
        continue;
      }
      const gaps = runs.map(gapsOf);
      if (attempts.every((a) => a >= 2) && gaps.every((g) => g.every((v) => v < NO_WAIT_MS))) {
        emit({ check: 'retry-policy', rule: 'RTY-03', strength: 'MUST', severity: 'error', method: r.method, route, symbol, trace: base,
          message: text`${r.method} ${route} retried ${host} ${M('retries', attempts[0] - 1)} times with no wait: every gap between attempts was under ${D('noWaitMs', NO_WAIT_MS)} ms (${M('gaps', gaps[0].map((v) => Number(v.toFixed(1))), gaps[0].map((v) => fmt(Math.round(v))).join(', '))} ms), with the stub answering ${status} (RTY-03).` });
        continue;
      }
      // The same wait each time, judged on the delays the twin declared, not
      // on a clock (absolute waits, docs/CONTRACT.md; the owner, 20 November
      // 2026), each timer as the twin set it (scripts/trace/timers.js). A gap
      // of NO_WAIT_MS or more with no timer seen in it is info, "wait not
      // observed", never a clean result (the owner). Every wait of every
      // run, warm-up included, declared alike, three or more: no jitter.
      // A gap's wait is the longest timer set after one attempt that fired
      // by the next (a request deadline outlasts the gap; a jittered wait
      // can be any length, a draw of 1 ms included).
      let v;
      try { v = waitVerdict([x.warm, ...runs].filter(Boolean).map((q) => ({ attempts: hitsOf(q).map((h) => h.at), timers: q.timers })), NO_WAIT_MS); } catch (e) { throw new Error(`${twin}: ${r.id}: ${e.message}: run scripts/trace.sh again`); }
      if (v.kind === 'unobserved') emit({ check: 'retry-policy', rule: 'RTY-03', strength: 'MUST', severity: 'info', unresolved: true, method: r.method, route, symbol, trace: { ...base, gaps: v.unseen.map((g) => Number(g.gap.toFixed(1))) },
        message: text`Wait not observed: ${r.method} ${route} spaced ${M('unseen', v.unseen.length)} of its retries of ${host} ${D('noWaitMs', NO_WAIT_MS)} ms or more apart (${M('gaps', v.unseen.map((g) => Number(g.gap.toFixed(1))), v.unseen.map((g) => fmt(Math.round(g.gap))).join(', '))} ms) with no timer the harness records in the gap (setTimeout, global or from node:timers, or node:timers/promises' setTimeout or scheduler.wait), so whether the wait is fixed is not judged.` });
      else if (v.kind === 'fixed') emit({ check: 'retry-policy', rule: 'RTY-03', strength: 'MUST', severity: 'error', method: r.method, route, symbol, trace: { ...base, waits: v.waits },
        message: text`${r.method} ${route} waited the same time before each retry of ${host}: ${D('waitMs', v.waits[0], fmt(v.waits[0]))} ms, as its code declares it, in all ${M('waits', v.waits.length)} waits: no jitter, so clients that failed together retry together (RTY-03).` });
    }
  }

  // ---- Hangs (judge "hang", L07): the stub accepts the outbound call and
  // never answers (or, for "lock", the database never finishes the
  // statement). A request with no response by timeoutMs, in every run, has
  // no deadline on that call (TMO-01). The request names the function it
  // drives (symbol), for linking to the static finding.
  for (const r of spec.judge === 'hang' ? spec.requests : []) {
    const x = hi.requests.find((q) => q.id === r.id);
    const route = x.route ?? r.path;
    const runs = [x, x.first ?? x.other].filter(Boolean);
    const host = Object.entries(r.upstream?.hosts ?? {}).find(([, a]) => a.hang)?.[0] ?? r.waitsOn ?? null;
    const trace = { judge: 'hang', path: x.path, ...(host ? { host } : {}), ...(r.symbol ? { symbol: r.symbol } : {}), scales: [{ scale: HI, timedOut: runs.every((q) => q.timedOut), ms: x.ms }] };
    if (runs.every((q) => q.timedOut)) emit({ check: 'no-timeout', rule: RULE_TMO, strength: 'MUST', severity: 'error', method: r.method, route, symbol: r.symbol ?? null, trace,
      message: text`${r.symbol ?? route} was still waiting on ${host ?? 'its call'} when the harness gave up after ${D('timeoutMs', r.timeoutMs, fmt(r.timeoutMs))} ms, with the other side accepting the call and never answering: nothing ends the wait (TMO-01).` });
    else if (runs.some((q) => q.timedOut)) emit({ check: 'no-timeout', rule: RULE_TMO, strength: 'MUST', severity: 'info', unresolved: true, method: r.method, route, symbol: r.symbol ?? null, trace,
      message: `${r.symbol ?? route} timed out in one run but not the other.` });
  }

  // ---- The event loop held (judge "loop", L09): the longest stretch the
  // loop could not run during the request (monitorEventLoopDelay's max),
  // against the request's time, over the runs after the warm-up. A timing:
  // it counts only under the timing lock; otherwise it is info.
  for (const r of spec.judge === 'loop' ? spec.requests : []) {
    const x = hi.requests.find((q) => q.id === r.id);
    if ((x.status ?? 500) >= 400) throw new Error(`${twin}: ${r.method} ${x.path} answered ${x.status}; the fixture or its seed is wrong`);
    const route = x.route ?? r.path;
    const judged = x.samples.slice(1);
    const blocked = judged.map((s) => s.loopMaxMs ?? 0);
    const shares = judged.map((s) => (s.ms > 0 ? (s.loopMaxMs ?? 0) / s.ms : 0));
    const clears = blocked.map((b, k) => b >= BLOCK_MS && shares[k] >= BLOCK_SHARE);
    const env0 = { before: raw.environment?.before ?? environment(), after: raw.environment?.after ?? environment() };
    let v;
    // The relative timing rule (docs/decisions.md, Q8): every run, none, or a mix.
    { const c = ruleC({ clears, samples: blocked, ...env0 }); if (!c.holds) continue; v = c.timing; }
    const t = { ...v, why: Array.isArray(v.why) ? v.why.join('; ') || null : v.why ?? null };
    const share = Math.min(...shares);
    const trace = { judge: 'timing', path: x.path, timing: t, scales: [{ scale: HI, ms: Number(t.median.toFixed(1)) }] };
    if (t.reliable) emit({ check: 'blocking-work', rule: 'OVL-12', strength: 'SHOULD', severity: 'warning', method: r.method, route, trace,
      message: text`${r.method} ${route} held the event loop for ${M('stretchMs', Number(t.median.toFixed(1)), fmt(Math.round(t.median)))} ms at a stretch (median of ${D('runs', blocked.length)}, spread ${M('spread', Number(t.spread.toFixed(3)), (t.spread * 100).toFixed(1))}%), at least ${M('share', Number(share.toFixed(3)), Math.round(share * 100))}% of the request's own time: no other request is served meanwhile (OVL-12).` });
    else emit({ check: 'blocking-work', rule: 'OVL-12', strength: 'SHOULD', severity: 'info', unresolved: true, method: r.method, route, trace,
      message: text`${r.method} ${route} appeared to hold the event loop for most of the request, but timing unreliable: ${M('why', t.why)}.` });
  }

  // ---- Connections opened per request (judge "connections", L13): new
  // backends of the app role at the database while one request ran, after
  // the warm-up. A process with one pool opens none once it is warm; a pool
  // or client made per request opens one every time (CAP-08).
  for (const r of spec.judge === 'connections' ? spec.requests : []) {
    const x = hi.requests.find((q) => q.id === r.id);
    if ((x.status ?? 500) >= 400) throw new Error(`${twin}: ${r.method} ${x.path} answered ${x.status}; the fixture or its seed is wrong`);
    const route = x.route ?? r.path;
    const opened = [x.first ?? x.other ?? x, x].map((q) => q.connections?.opened ?? 0);
    const trace = { judge: 'connections', path: x.path, ...(r.symbol ? { symbol: r.symbol } : {}), scales: [{ scale: HI, connections: opened[1] }] };
    if (opened.every((o) => o >= 1)) emit({ check: 'pool-sizing', rule: 'CAP-08', strength: 'MUST', severity: 'error', method: r.method, route, symbol: r.symbol ?? null, trace,
      message: text`${r.method} ${route} opened ${M('opened', opened[1], `${opened[1]} new connection${opened[1] === 1 ? '' : 's'}`)} to the database on each request after the first, ${M('open', x.connections.open)} open once it answered: a pool made per request, whose connections every request adds (CAP-08). Counted at the database, in pg_stat_activity.` });
  }

  // ---- The same read again (judge "cache", L10), from the statement log
  // with parameters. Within one request: the same read with the same
  // parameters twice, with no write between, in both runs after the warm-up
  // (DAT-06). Across requests, for a GET whose response carries no
  // a freshness lifetime in its Cache-Control: the same read with the same parameters in every
  // request after the warm-up, whose blocks grow with the table while its
  // rows do not (DAT-06).
  for (const r of spec.judge === 'cache' ? spec.requests : []) {
    const x = hi.requests.find((q) => q.id === r.id);
    if ((x.status ?? 500) >= 400) throw new Error(`${twin}: ${r.method} ${x.path} answered ${x.status}; the fixture or its seed is wrong`);
    const route = x.route ?? r.path;
    const runs = [x.first, x.last];
    const keyOf = (s) => `${normalizeSql(s.sql)}|${s.params ?? ''}`;
    const twice = (logged) => {
      const seen = new Map();
      const found = new Map();
      for (const s of logged) {
        if (WRITE.test(s.sql)) { seen.clear(); continue; }
        if (!READ.test(s.sql)) continue;
        const k = keyOf(s);
        seen.set(k, (seen.get(k) ?? 0) + 1);
        if (seen.get(k) >= 2) found.set(k, { ...s, times: Math.max(found.get(k)?.times ?? 0, seen.get(k)) });
      }
      return found;
    };
    const within = runs.map((q) => twice(q.logged));
    for (const [k, s] of within[0]) {
      if (!within[1].has(k)) continue;
      emit({ check: 'no-cache', rule: 'DAT-06', strength: 'SHOULD', severity: 'warning', method: r.method, route, statement: s.sql,
        trace: { judge: 'repeat', path: x.path, statement: s.sql, scales: [{ scale: HI, times: s.times }] },
        message: text`${r.method} ${route} ran \`${s.sql}\` ${M('times', s.times)} times in one request with the same parameters (${s.params ?? 'none'}) and no write between: every run after the first reads what the request already has (DAT-06). From the statement log.` });
    }
    // Only a freshness lifetime lets a client or proxy skip the request; an
    // ETag alone (Express adds a weak one to every response) still has the
    // server do the work to answer 304.
    if (r.method !== 'GET' || fresh(x.cacheHeaders?.cacheControl)) continue;
    const lx = lo?.requests.find((q) => q.id === r.id);
    const per = (stats, sql) => { const e = Object.entries(stats ?? {}).find(([q]) => normalizeSql(q) === normalizeSql(sql)); return e && e[1].calls ? { blocks: e[1].blocks / e[1].calls, rows: e[1].rows / e[1].calls } : null; };
    const inAll = (q) => new Set(q.logged.filter((s) => READ.test(s.sql)).map(keyOf));
    const keys = [...inAll(x.first)].filter((k) => inAll(x.last).has(k) && (!x.warm?.logged || x.warm.logged.some((s) => keyOf(s) === k)));
    for (const k of keys) {
      const s = x.last.logged.find((q) => keyOf(q) === k);
      const a = per(lx?.statements, s.sql);
      const b = per(x.statements, s.sql);
      if (!a || !b || !(a.blocks > 0) || b.blocks / a.blocks < COST_RATIO || b.rows > a.rows) continue;
      const ratio = b.blocks / a.blocks;
      emit({ check: 'no-cache', rule: 'DAT-06', strength: 'SHOULD', severity: 'warning', method: r.method, route, statement: s.sql,
        trace: { judge: 'repeat', path: x.path, statement: s.sql, ratio, scales: [{ scale: LO, rows: Math.round(a.rows) }, { scale: HI, rows: Math.round(b.rows) }] },
        message: text`${r.method} ${route} ran \`${s.sql}\` on every request with the same parameters, nothing cached in front and no freshness lifetime in its Cache-Control, and its cost grows with the table: ${M('blocks', Math.round(b.blocks), fmt(Math.round(b.blocks)))} blocks a call at ${D('scale', HI)}x against ${M('blocks', Math.round(a.blocks), fmt(Math.round(a.blocks)))} at ${D('scale', LO)}x, for the same ${M('rows', Math.round(b.rows))} row(s) (DAT-06).` });
    }
  }

  // ---- Memory kept per request (judge "memory", L05): the twin's heap
  // after a full collection, at each point of a soak whose requests each
  // carry a key of their own. Judged on the least-squares slope over the
  // points from the soak's first count on (MIN_POINTS or more), which the
  // counts put past every bound a fixed version sets: KEPT_BYTES or more a
  // request with a fit of MIN_FIT or better keeps something per request that
  // nothing removes (STB-05). No other twin is needed.
  const soakSlope = (x, r) => slopeOf(x.points.filter((p) => p.requests >= r.counts[0]).map((p) => ({ x: p.requests, y: p.heapUsed })));
  for (const r of spec.judge === 'memory' ? spec.soaks : []) {
    const x = (hi.soaks ?? []).find((q) => q.id === r.id);
    if (!x || x.points.some((p) => !p.collected)) throw new Error(`${twin}: soak ${r.id} has no heap measured after a full collection`);
    const mine = soakSlope(x, r);
    if (mine.points < MIN_POINTS) throw new Error(`soak ${r.id}: ${mine.points} point(s) past ${r.counts[0]} requests, fewer than ${MIN_POINTS}`);
    const route = r.route ?? r.path;
    const trace = { judge: 'memory', path: r.path, slope: Number(mine.slope.toFixed(1)), r2: Number(mine.r2.toFixed(3)), scales: x.points.map((p) => ({ scale: HI, requests: p.requests, heapBytesPerRequest: p.requests ? Number(((p.heapUsed - x.points[0].heapUsed) / p.requests).toFixed(1)) : 0 })) };
    if (mine.slope >= KEPT_BYTES && mine.r2 >= MIN_FIT) emit({ check: 'memory-growth', rule: 'STB-05', strength: 'SHOULD', severity: 'warning', method: r.method, route, trace,
      message: text`${r.method} ${route} kept about ${M('bytesPerRequest', Number(mine.slope.toFixed(1)), fmt(Math.round(mine.slope)))} bytes of heap per request from request ${D('from', r.counts[0], fmt(r.counts[0]))} to ${D('to', r.counts.at(-1), fmt(r.counts.at(-1)))}, each with a key of its own, measured after a full collection (least-squares slope over ${D('points', mine.points)} points, R² ${M('r2', Number(mine.r2.toFixed(3)), mine.r2.toFixed(2))}; reported at ${D('minBytes', KEPT_BYTES)} bytes a request or more with R² ${D('minR2', MIN_FIT)} or better): the heap grows with every new key and nothing gives it back (STB-05).` });
    SOAKS.push(`${twin} ${r.id}: ${mine.slope.toFixed(1)} B/request, R² ${mine.r2.toFixed(2)} (${mine.points} points)${mine.slope >= KEPT_BYTES && mine.r2 >= MIN_FIT ? ', reported' : ''}`);
  }

  // ---- The first request after a start (judge "starts", L11): for each
  // start, the first request against the median of the ones after it. A
  // first request FIRST_EXTRA_MS or more and FIRST_RATIO times slower, in
  // every start, waits for set-up a start could have done (STB-10). A
  // timing: judged under the timing lock on the first-request times.
  for (const r of spec.judge === 'starts' ? spec.starts : []) {
    const x = (hi.starts ?? []).find((q) => q.id === r.id);
    const later = x.samples.map((s) => median(s.laterMs));
    // With a warm-up (trace.json "warmup", L11): the route's first-request
    // extra (first minus the median of the later ones) against the baseline,
    // at FIRST_RATIO times and FIRST_EXTRA_MS above it; no other twin needed.
    // The baseline is the cheapest route's extra in the same process after
    // the warm-up, or, with the 404 fallback, the 404 request's own time
    // (baselineOf "warm-up").
    // Without one: the first request against the later ones of its start.
    const warm = x.samples.every((q) => Number.isFinite(q.extraMs));
    const wu = hi.warmup ?? null;
    const warmedBy = !wu ? '' : wu.source === 'fallback' ? ` after requests to a path that does not exist (GET, then POST with a small JSON body, to ${wu.path} and a random suffix, a 404: they warm the framework and its body parser, not the database driver)` : ` after a warm-up request to ${wu.method} ${wu.path} (from ${wu.source})`;
    const clears = warm
      ? x.samples.map((s) => s.extraMs >= FIRST_RATIO * s.baselineMs && s.extraMs - s.baselineMs >= FIRST_EXTRA_MS)
      : x.samples.map((s, k) => s.firstMs - later[k] >= FIRST_EXTRA_MS && s.firstMs >= FIRST_RATIO * later[k]);
    const env0 = { before: raw.environment?.before ?? environment(), after: raw.environment?.after ?? environment() };
    const firsts = x.samples.map((s) => (warm ? s.extraMs : s.firstMs));
    let v;
    // The relative timing rule (docs/decisions.md, Q8): every start, none, or a mix.
    { const c = ruleC({ clears, samples: firsts, ...env0 }); if (!c.holds) continue; v = c.timing; }
    const t = { ...v, why: Array.isArray(v.why) ? v.why.join('; ') || null : v.why ?? null };
    const route = r.route ?? r.path;
    const steady = median(later);
    const trace = { judge: 'timing', path: x.path, timing: t, ...(wu ? { warmup: { source: wu.source, method: wu.method, path: wu.path } } : {}), scales: [{ scale: HI, ms: Number(t.median.toFixed(1)) }] };
    if (t.reliable) emit({ check: 'cold-start', rule: 'STB-10', strength: 'SHOULD', severity: 'warning', method: r.method, route, trace,
      message: warm
        ? text`${r.method} ${route}'s first request after a start took ${M('extraMs', Number(t.median.toFixed(1)), fmt(Math.round(t.median)))} ms longer than the requests after it (median of ${D('starts', x.samples.length)} starts, spread ${M('spread', Number(t.spread.toFixed(3)), (t.spread * 100).toFixed(1))}%), against ${M('baselineMs', Number(median(x.samples.map((q) => q.baselineMs)).toFixed(1)), fmt(Math.round(median(x.samples.map((q) => q.baselineMs)))))} ms for ${x.samples.every((q) => q.baselineOf === 'warm-up') ? 'the warm-up request itself, in the same process' : 'the cheapest route in the same process'}${warmedBy}: the first request waits for set-up the start could have done (STB-10).`
        : text`${r.method} ${route} took ${M('firstMs', Number(t.median.toFixed(1)), fmt(Math.round(t.median)))} ms as the first request after a start (median of ${D('starts', x.samples.length)} starts, spread ${M('spread', Number(t.spread.toFixed(3)), (t.spread * 100).toFixed(1))}%), against ${M('laterMs', Number(steady.toFixed(1)), steady.toFixed(1))} ms for the requests after it: the first request waits for set-up the start could have done (STB-10).` });
    else emit({ check: 'cold-start', rule: 'STB-10', strength: 'SHOULD', severity: 'info', unresolved: true, method: r.method, route, trace,
      message: text`${r.method} ${route}'s first request after a start looked slow, but timing unreliable: ${M('why', t.why)}.` });
  }

  // ---- Plans (judge "plans", L03): auto_explain's plan of each statement a
  // request ran, at the top scale, in both runs after the warm-up. A Seq Scan
  // with a filter on a table of BIG_TABLE rows or more that returns under
  // SELECTIVE of the rows it read wants an index on what it filters by
  // (DAT-07). A small table the owner names (smallTables) is left out.
  const small = new Set(spec.smallTables ?? []);
  for (const r of spec.judge === 'plans' ? spec.requests : []) {
    const x = hi.requests.find((q) => q.id === r.id);
    if ((x.status ?? 500) >= 400) throw new Error(`${twin}: ${r.method} ${x.path} answered ${x.status}; the fixture or its seed is wrong`);
    const route = x.route ?? r.path;
    const seqs = (q) => {
      const found = [];
      for (const p of q.plans ?? []) {
        const walk = (n) => {
          if (n['Node Type'] === 'Seq Scan' && n.Filter && !small.has(n['Relation Name'])) {
            const loops = n['Actual Loops'] ?? 1;
            const kept = (n['Actual Rows'] ?? 0) * loops;
            const read = kept + (n['Rows Removed by Filter'] ?? 0) * loops;
            const size = hi.tables?.[n['Relation Name']] ?? 0;
            if (size >= BIG_TABLE && read > 0 && kept / read < SELECTIVE) found.push({ table: n['Relation Name'], filter: n.Filter, kept, read, size, sql: p['Query Text'] });
          }
          for (const c of n.Plans ?? []) walk(c);
        };
        walk(p.Plan);
      }
      return found;
    };
    const [a, b] = [x.first, x.last].map(seqs);
    for (const f of b) {
      if (!a.some((g) => g.table === f.table && g.filter === f.filter)) continue;
      emit({ check: 'missing-index', rule: 'DAT-03', strength: 'SHOULD', severity: 'warning', method: r.method, route, statement: f.sql,
        trace: { judge: 'plans', path: x.path, plan: 'Seq Scan', table: f.table, statement: f.sql, scales: [{ scale: HI, tableRows: f.size, rows: f.kept, removedRows: f.read - f.kept }] },
        message: text`${r.method} ${route} read ${f.table} with a sequential scan, ${M('read', f.read, fmt(f.read))} rows of its ${M('size', f.size, fmt(f.size))} for the ${M('kept', f.kept, fmt(f.kept))} that pass ${f.filter}: PostgreSQL had no index to go to them directly (DAT-07). From auto_explain, on seeded data at ${D('scale', HI)}x.` });
    }
  }

  for (const f of out) {
    const errors = validate(extensionSchema, f.erlang);
    if (errors.length) throw new Error(`${twin}: ${f.fingerprint}: erlang extension: ${errors.join('; ')}`);
  }
  const r = report({
    specialist: 'erlang', version: VERSION, subject: relative(process.cwd(), subjectDir) || '.', started: new Date(raw.started ?? Date.now()),
    findings: out,
    // measured: the report's own run-level paths that a machine measures
    // (the warm-up's times), dropped when runs are compared, as a finding's
    // measured paths are (scripts/compare-reports.js).
    run: { measured: hi.warmup ? ['erlang.trace.warmup.runs[].ms'] : [], trace: { image: raw.image, fixture: raw.fixture, form: raw.form, twin, judge: spec.judge, ...(hi.warmup ? { warmup: hi.warmup } : {}), seed: raw.seed, scales: Object.fromEntries(Object.entries(raw.scales).map(([k, v]) => [k, { n: v.n, tables: v.tables }])) } },
  });
  writeFileSync(join(outDir, twin, 'report.json'), JSON.stringify(r, null, 2) + '\n');
  return r;
}

const keyOf = (f) => `${f.check} ${f.rules?.[0] ?? ''} ${(f.where.endpoints ?? []).map((e) => `${e.method} ${e.route}`).join(',')}${f.erlang?.trace?.host ? ` ${f.erlang.trace.host}` : ''}`;
const matches = defectMatches;
// A form passes only when the planted twin yields a failing finding for
// every defect and the clean twin none. In a timed form (L09, L11), a defect
// the planted twin reports only as "timing unreliable" is not a pass: the
// form is UNRELIABLE (exit 3), unless something else failed (exit 1).
// Count-based forms never produce one.
let failed = false;
let unreliable = false;
// judge "memory": each soak's slope and fit, both twins, printed so a CI log
// carries them.
const SOAKS = [];
const say = (ok, what, detail, status = ok ? 'PASS' : 'FAIL') => { if (status === 'FAIL') failed = true; if (status === 'UNRELIABLE') unreliable = true; console.log(`${status}  ${spec.fixture} ${spec.form} ${what}${detail ? `  (${detail})` : ''}`); };
const verdictOf = (t) => `samples ${JSON.stringify((t.samples ?? []).map((x) => Number(Number(x).toFixed(1))))}, spread ${t.spread == null ? 'unknown' : `${(t.spread * 100).toFixed(1)}%`}, load before ${t.before?.load1 ?? '?'}/${t.before?.cpus ?? '?'} CPUs, after ${t.after?.load1 ?? '?'}/${t.after?.cpus ?? '?'}: ${Array.isArray(t.why) ? t.why.join('; ') : t.why}`;
for (const twin of ['planted', 'clean']) {
  if (!existsSync(join(outDir, twin, 'raw.json'))) { say(false, twin, 'no raw.json: run scripts/trace.sh'); continue; }
  const r = judgeTwin(twin);
  const judged = r.findings.filter((f) => f.severity !== 'info');
  const infos = r.findings.filter((f) => f.severity === 'info').map(keyOf);
  const wu = r.erlang?.trace?.warmup;
  if (wu) console.log(`WARM-UP  ${spec.fixture} ${spec.form} ${twin}: ${wu.source === 'fallback' ? `fallback, GET then POST with a small JSON body to ${wu.path} and a random suffix, a path that does not exist (the GET answered ${[...new Set(wu.runs.map((x) => x.status))].join(', ')}): warms the framework and its body parser, not the database driver` : `configured in ${wu.source}, ${wu.method} ${wu.path} (answered ${[...new Set(wu.runs.map((x) => x.status))].join(', ')})`}`);
  if (twin === 'planted') {
    // A timing defect the rule would not judge (load, spread) is
    // inconclusive: not missed, and not a pass.
    const inconclusive = spec.defects.filter((d) => !judged.some((f) => matches(d, f)) && r.findings.some((f) => f.severity === 'info' && matches(d, f) && f.erlang?.trace?.timing?.reliable === false));
    const missing = spec.defects.filter((d) => !judged.some((f) => matches(d, f)) && !inconclusive.includes(d));
    for (const d of inconclusive) {
      const f = r.findings.find((x) => x.severity === 'info' && matches(d, x) && x.erlang?.trace?.timing?.reliable === false);
      console.log(`UNRELIABLE  ${spec.fixture} ${spec.form} planted: ${d.check} ${d.rule ?? ''} ${d.method} ${d.route}${d.host ? ` ${d.host}` : ''}: timing unreliable (${verdictOf(f.erlang.trace.timing)})`);
    }
    const expectedMiss = (f) => (spec.expectedMisses ?? []).some((d) => matches(d, f));
    const extra = judged.filter((f) => !spec.defects.some((d) => matches(d, f)) && !expectedMiss(f));
    for (const d of spec.expectedMisses ?? []) console.log(`EXPECTED  ${spec.fixture} ${spec.form} planted: ${d.check} ${d.rule ?? ''} ${d.method} ${d.route}, below the detection floor (${d.floor}): ${judged.some((f) => matches(d, f)) ? 'found this run all the same' : 'not found, as documented'}`);
    const unlinked = spec.defects.filter((d) => d.linked && judged.some((f) => matches(d, f) && !f.detection.includes('static')));
    const wrong = missing.length || extra.length || unlinked.length;
    say(!wrong && !inconclusive.length, `planted: ${judged.filter((f) => spec.defects.some((d) => matches(d, f))).length}/${spec.defects.length} defects traced${inconclusive.length ? ` (${inconclusive.length} timing unreliable)` : ''}${spec.defects.some((d) => d.linked) ? `, ${spec.defects.filter((d) => d.linked && !inconclusive.includes(d)).length - unlinked.length} linked to a static finding` : ''}`,
      [...missing.map((d) => `missed ${d.check} ${d.rule ?? ''} ${d.method} ${d.route}`), ...extra.map((f) => `decoy reported: ${keyOf(f)}`), ...unlinked.map((d) => `not linked: ${d.method} ${d.route}`), ...infos.map((i) => `info: ${i}`)].join('; '), wrong ? 'FAIL' : inconclusive.length ? 'UNRELIABLE' : 'PASS');
    for (const f of extra) console.log(`      ${f.message}`);
  } else {
    say(!judged.length, `clean: ${judged.length} error(s) or warning(s)`, [...judged.map((f) => `reported: ${keyOf(f)}`), ...infos.map((i) => `info: ${i}`)].join('; '));
    for (const f of judged) console.log(`      ${f.message}`);
  }
}
for (const line of SOAKS) console.log(`SOAK  ${spec.fixture} ${spec.form} ${line}`);
// Timed judges: the measurements behind each verdict, both twins, printed so
// a CI log carries them.
if (TIMED_TRACE_JUDGES.has(spec.judge) && ['planted', 'clean'].every((t) => existsSync(join(outDir, t, 'raw.json')))) {
  for (const twin of ['planted', 'clean']) {
    const raw = JSON.parse(readFileSync(join(outDir, twin, 'raw.json'), 'utf8'));
    const e = raw.environment ?? {};
    const scale = raw.scales[Object.keys(raw.scales).sort((a, b) => b - a)[0]];
    const rows = spec.judge === 'loop'
      ? (scale.requests ?? []).map((q) => `${q.id}: blocked ms ${JSON.stringify(q.samples.slice(1).map((s) => Math.round(s.loopMaxMs ?? 0)))}, share of request ${JSON.stringify(q.samples.slice(1).map((s) => Number(((s.loopMaxMs ?? 0) / s.ms).toFixed(2))))}`)
      : (scale.starts ?? []).map((q) => `${q.id}: first ms ${JSON.stringify(q.samples.map((s) => Math.round(s.firstMs)))}, ${q.samples.every((s) => Number.isFinite(s.extraMs)) ? `extra ms ${JSON.stringify(q.samples.map((s) => Math.round(s.extraMs)))}, baseline ms ${JSON.stringify(q.samples.map((s) => Math.round(s.baselineMs)))}, position ${JSON.stringify(q.samples.map((s) => s.position))}` : `first over later ${JSON.stringify(q.samples.map((s) => Number((s.firstMs / median_(s.laterMs)).toFixed(1))))}`}`);
    console.log(`      measured ${twin}: load ${e.before?.load1}/${e.before?.cpus} before, ${e.after?.load1}/${e.after?.cpus} after`);
    for (const row of rows) console.log(`        ${row}`);
  }
}
// Margins (the owner, 20 November 2026; docs/CONTRACT.md, "Margins in the
// fixture suite"; lib/margin.js). In a timed form, a row's samples are judged
// on their median against the margin, and each sample on its own against the
// judge's bar; a sample past the margin but inside the bar is an OUTLIER
// line with its diagnostics, not a failure.
//   Decoy margin: every judged route of the clean twin, and every judged
//   route of the planted twin that is neither a planted defect nor an
//   expected miss (EXPECTED-MISS, printed, not judged). A verdict needs every
//   condition of its bar, so a decoy is held off by any one of them: the
//   median of some condition is at most half its threshold. It fails if a
//   sample reaches the bar.
//   Planted margin: every planted defect clears every condition's margin on
//   the median: 2x the bar (a share: half way from the bar to 1). It fails
//   if a sample falls below the bar.
//   loop:   the longest stretch (BLOCK_MS) and its share of the request
//           (BLOCK_SHARE);
//   starts: the first request's extra over the baseline (FIRST_EXTRA_MS) and
//           its ratio to the baseline (FIRST_RATIO).
if (TIMED_TRACE_JUDGES.has(spec.judge) && ['planted', 'clean'].every((t) => existsSync(join(outDir, t, 'raw.json')))) {
  const twice = (bar, share) => (share && 2 * bar > 1 ? 1 - (1 - bar) / 2 : 2 * bar);
  const extra = (x) => (Number.isFinite(x.extraMs) ? x.extraMs - x.baselineMs : x.firstMs - median(x.laterMs));
  const ratio = (x) => (Number.isFinite(x.extraMs) ? (x.baselineMs > 0 ? x.extraMs / x.baselineMs : Infinity) : x.firstMs / median(x.laterMs));
  const share = (x) => (x.ms > 0 ? (x.loopMaxMs ?? 0) / x.ms : 0);
  const condsFor = (margin) => (spec.judge === 'loop'
    ? [{ what: 'ms at a stretch', bar: () => BLOCK_MS, margin: () => margin(BLOCK_MS), of: (x) => x.loopMaxMs ?? 0 },
      { what: 'share of the request', bar: () => BLOCK_SHARE, margin: () => margin(BLOCK_SHARE, true), of: share }]
    : [{ what: 'ms over the baseline', bar: () => FIRST_EXTRA_MS, margin: () => margin(FIRST_EXTRA_MS), of: extra },
      { what: 'times the baseline', bar: () => FIRST_RATIO, margin: () => margin(FIRST_RATIO), of: ratio }]);
  const decoyConds = condsFor((bar) => bar / 2);
  const plantedConds = condsFor(twice);
  const num = (v) => (Number.isFinite(v) ? Number(v.toFixed(2)) : 'inf');
  const listed = (conds, samples, label) => conds.map((c) => `${c.what} ${JSON.stringify(samples.map((x) => num(c.of(x))))} (${label(c)} ${Number(c.margin().toFixed(3))})`).join('; ');
  // A sample's diagnostics: the load average, and for a start the later
  // requests' median, the collections during the first request and the
  // database's writes since the seed.
  const diag = (x) => JSON.stringify({ load1: x.load1 ?? null, ...(spec.judge === 'starts' ? { laterMedianMs: Number(median(x.laterMs).toFixed(1)), gcs: x.gcs ?? null, db: x.db ?? null, at: x.at ?? null } : { ms: x.ms ?? null }) });
  const quiet = (d, it) => d.method === it.method && d.route === it.route;
  for (const twin of ['planted', 'clean']) {
    const raw = JSON.parse(readFileSync(join(outDir, twin, 'raw.json'), 'utf8'));
    const scale = raw.scales[Object.keys(raw.scales).sort((a, b) => b - a)[0]];
    const items = spec.judge === 'loop'
      ? (scale.requests ?? []).map((q) => ({ method: q.method, route: q.route ?? q.path, samples: q.samples.slice(1) }))
      : (scale.starts ?? []).map((q) => ({ method: q.method, route: q.route ?? q.path, samples: q.samples }));
    for (const it of items) {
      const where = `${spec.fixture} ${spec.form} ${twin} ${it.method} ${it.route}`;
      // Beside each sample: the load average when it was taken, and, for a
      // start, the median of the requests after the first.
      const context = `; load ${JSON.stringify(it.samples.map((x) => x.load1 ?? null))}${spec.judge === 'starts' ? `; later requests, median ms ${JSON.stringify(it.samples.map((x) => Number(median(x.laterMs).toFixed(1))))}` : ''}`;
      if (twin === 'planted' && spec.defects.some((d) => quiet(d, it))) {
        const m = plantedMargin(it.samples, plantedConds);
        const medians = plantedConds.map((c, k) => `${c.what} ${num(m.medians[k] * c.margin())}`).join(', ');
        console.log(`PLANTED  ${where}: ${listed(plantedConds, it.samples, () => '2x the bar')}; median ${medians}${m.held ? '' : ': SHORT on the median'}${m.below.length ? `: BELOW THE BAR in sample(s) ${m.below.map((i) => i + 1).join(', ')}` : ''}`);
        for (const i of m.outliers) console.log(`OUTLIER  ${where}: sample ${i + 1} short of the planted margin but clearing the bar (not failed): ${plantedConds.map((c) => `${c.what} ${num(c.of(it.samples[i]))}`).join(', ')}; ${diag(it.samples[i])}`);
        if (!m.held) say(false, 'planted: planted margin', `${it.method} ${it.route}: the median cleared its bar by less than 2x`);
        if (m.below.length) say(false, 'planted: planted margin', `${it.method} ${it.route}: ${m.below.length} sample(s) below the judge's bar`);
        continue;
      }
      if (twin === 'planted' && (spec.expectedMisses ?? []).some((d) => quiet(d, it))) {
        console.log(`EXPECTED-MISS  ${where}, not a decoy, margin not judged: ${listed(decoyConds, it.samples, () => 'half the bar')}${context}`);
        continue;
      }
      const m = decoyMargin(it.samples, decoyConds);
      const medians = decoyConds.map((c, k) => `${c.what} ${num(m.medians[k] * c.margin())}`).join(', ');
      console.log(`DECOY  ${where}: ${listed(decoyConds, it.samples, () => 'half the bar')}${context}; median ${medians}${m.kept ? '' : ': OVER on the median'}${m.reached.length ? `: REACHED THE BAR in sample(s) ${m.reached.map((i) => i + 1).join(', ')}` : ''}`);
      for (const i of m.outliers) console.log(`OUTLIER  ${where}: sample ${i + 1} past the decoy margin but inside the bar (not failed): ${decoyConds.map((c) => `${c.what} ${num(c.of(it.samples[i]))}`).join(', ')}; ${diag(it.samples[i])}`);
      if (!m.kept) say(false, `${twin}: decoy margin`, `${it.method} ${it.route}: the median reached half the bar on every condition`);
      if (m.reached.length) say(false, `${twin}: decoy margin`, `${it.method} ${it.route}: ${m.reached.length} sample(s) reached the judge's bar`);
    }
  }
}
process.exit(failed ? 1 : unreliable ? 3 : 0);
