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
import { judge as timingJudge, ruleC, MIN_REPEATS, environment, REASON } from '../../lib/timing.js';

// Candidate rule (c) (docs/decisions.md, Q8; lib/timing.js ruleC) is printed beside
// the current rule for the timed judges (loop, starts); only "current"
// decides the exit code and writes the reports.
const median_ = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
import { growth, rowsGrowth, repeated, linkStatic, normalizeSql, routePattern, fmt, COMPRESS_MIN, UNREAD, ROWS, SLOPE, slopeOf, MIN_POINTS } from '../../lib/trace-judge.js';

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
// judge "memory": heap kept per request, after a full collection: the slope
// over the soak's points past its first count (past every bound a clean twin
// sets), at least KEPT_BYTES and KEPT_RATIO times the other twin's slope on
// the same soak (taken as at least 1 byte).
const KEPT_BYTES = 32;
const KEPT_RATIO = 3;
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

function judgeTwin(twin, rule = 'current') {
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
    if (s) {
      // A static finding left at info because reading could not decide
      // (unresolved) takes the trace's severity: the trace decided it.
      const resolves = s.severity === 'info' && s.erlang?.unresolved && severity !== 'info';
      const { unresolved: _u, ...ext } = s.erlang ?? {};
      out.push(finding({
        specialist: 'erlang', check, severity: resolves ? severity : s.severity, fingerprint: s.fingerprint,
        message: `${s.message} Traced on seeded data: ${message}`,
        detection: [...new Set([...s.detection, 'trace'])], rules: s.rules, where: s.where,
        extension: { ...(resolves ? ext : s.erlang), trace: ev },
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
      message, detection: ['trace'], rules: [rule],
      where: { endpoints: [{ method, route }], ...(at.length ? { locations: at.map((l) => ({ ...l, column: 1 })) } : {}) },
      extension: { strength, ...(unresolved ? { unresolved: true } : {}), ...(fix ? { fix } : {}), trace: ev },
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
        message: `${r.method} ${route} had ${held} pooled connection${held === 1 ? '' : 's'} checked out while its outbound call (${x.upstream[0].method} ${x.upstream[0].host}${x.upstream[0].path}) was answered: the connection waits on the other service (STB-09). Counted from the twin's pool.` });
      else if (held >= 1) emit({ check: 'pool-exhaustion', rule: 'STB-09', strength: 'SHOULD', severity: 'info', unresolved: true, method: r.method, route, trace, message: `${r.method} ${route} held a connection across its outbound call in one run but not the other.` });
    }
    if ((r.probes ?? []).includes('pool-after')) {
      const kept = (q) => (q.poolAfter.total - q.poolAfter.idle) - (q.poolBefore.total - q.poolBefore.idle);
      const ks = runs.map(kept);
      const trace = { judge: 'pool', path: x.path, scales: [{ scale: HI, keptAfterResponse: ks[0] }] };
      if (ks.every((k) => k >= 1)) emit({ check: 'pool-exhaustion', rule: 'STB-08', strength: 'MUST', severity: 'error', method: r.method, route, trace,
        message: `${r.method} ${route}${x.status >= 400 ? `, answering ${x.status},` : ''} left ${ks[0]} pooled connection${ks[0] === 1 ? '' : 's'} checked out after its response: the connection is never released on that path, and the pool runs out after as many such requests as it holds (STB-08). Counted from the twin's pool.` });
      else if (ks.some((k) => k >= 1)) emit({ check: 'pool-exhaustion', rule: 'STB-08', strength: 'MUST', severity: 'info', unresolved: true, method: r.method, route, trace, message: `${r.method} ${route} kept a connection after its response in one run but not the other.` });
    }
  }

  // ---- Attempts per request (judge "attempts", L06): outbound calls the
  // stub received for one user request, per host, with the stub failing
  // only that host. RTY-01: still retrying when the harness gave up.
  // RTY-03: no wait (every gap under NO_WAIT_MS), or the same wait every
  // time (gaps steady under the timing lock: no jitter). RTY-06: a reply
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
      if (runs.every((q) => q.timedOut) && attempts.every((a) => a >= 3)) {
        emit({ check: 'retry-policy', rule: 'RTY-01', strength: 'MUST', severity: 'error', method: r.method, route, symbol, trace: base,
          message: `${r.method} ${route} was still retrying ${host} when the harness gave up after ${fmt(r.timeoutMs)} ms: ${attempts[0]} attempts so far, with the stub failing every one (${status}). Nothing caps the attempts (RTY-01).` });
        continue;
      }
      if (status >= 400 && status < 500 && ![408, 429].includes(status)) {
        if (attempts.every((a) => a > 1)) emit({ check: 'retry-policy', rule: 'RTY-06', strength: 'MUST', severity: 'warning', method: r.method, route, symbol, trace: base,
          message: `${r.method} ${route} sent ${attempts[0]} requests to ${host} for one user request, though the first was answered ${status}, a reply that cannot succeed when sent again (RTY-06).` });
        continue;
      }
      const gaps = runs.map(gapsOf);
      if (attempts.every((a) => a >= 2) && gaps.every((g) => g.every((v) => v < NO_WAIT_MS))) {
        emit({ check: 'retry-policy', rule: 'RTY-03', strength: 'MUST', severity: 'error', method: r.method, route, symbol, trace: base,
          message: `${r.method} ${route} retried ${host} ${attempts[0] - 1} times with no wait: every gap between attempts was under ${NO_WAIT_MS} ms (${gaps[0].map((v) => fmt(Math.round(v))).join(', ')} ms), with the stub answering ${status} (RTY-03).` });
        continue;
      }
      // The same wait each time: the gaps of every run, warm-up included.
      const every = [x.warm, ...runs].filter(Boolean).flatMap(gapsOf);
      if (every.length >= 3 && Math.min(...every) >= NO_WAIT_MS) {
        const v = timingJudge({ samples: every, before: raw.environment?.before ?? environment(), after: raw.environment?.after ?? environment() });
        const t = { ...v, why: Array.isArray(v.why) ? v.why.join('; ') || null : v.why ?? null };
        const steady = t.spread !== null && t.spread <= 0.10;
        if (steady && t.reliable) emit({ check: 'retry-policy', rule: 'RTY-03', strength: 'MUST', severity: 'error', method: r.method, route, symbol, trace: { ...base, judge: 'timing', timing: t },
          message: `${r.method} ${route} waited the same time before each retry of ${host}, ${fmt(Math.round(t.median))} ms (${every.length} waits, spread ${(t.spread * 100).toFixed(1)}%): no jitter, so clients that failed together retry together (RTY-03).` });
        else if (steady) emit({ check: 'retry-policy', rule: 'RTY-03', strength: 'MUST', severity: 'info', unresolved: true, method: r.method, route, symbol, trace: { ...base, judge: 'timing', timing: t },
          message: `${r.method} ${route}'s waits before retrying ${host} looked fixed, but timing unreliable: ${t.why}.` });
      }
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
      message: `${r.symbol ?? route} was still waiting on ${host ?? 'its call'} when the harness gave up after ${fmt(r.timeoutMs)} ms, with the other side accepting the call and never answering: nothing ends the wait (TMO-01).` });
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
    if (rule === 'c') { const c = ruleC({ clears, samples: blocked, ...env0 }); if (!c.holds) continue; v = c.timing; }
    else { if (!clears.every(Boolean)) continue; v = timingJudge({ samples: blocked, ...env0 }); }
    const t = { ...v, why: Array.isArray(v.why) ? v.why.join('; ') || null : v.why ?? null };
    const share = Math.min(...shares);
    const trace = { judge: 'timing', path: x.path, timing: t, scales: [{ scale: HI, ms: Number(t.median.toFixed(1)) }] };
    if (t.reliable) emit({ check: 'blocking-work', rule: 'OVL-12', strength: 'SHOULD', severity: 'warning', method: r.method, route, trace,
      message: `${r.method} ${route} held the event loop for ${fmt(Math.round(t.median))} ms at a stretch (median of ${blocked.length}, spread ${(t.spread * 100).toFixed(1)}%), at least ${Math.round(share * 100)}% of the request's own time: no other request is served meanwhile (OVL-12).` });
    else emit({ check: 'blocking-work', rule: 'OVL-12', strength: 'SHOULD', severity: 'info', unresolved: true, method: r.method, route, trace,
      message: `${r.method} ${route} appeared to hold the event loop for most of the request, but timing unreliable: ${t.why}.` });
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
      message: `${r.method} ${route} opened ${opened[1]} new connection${opened[1] === 1 ? '' : 's'} to the database on each request after the first, ${x.connections.open} open once it answered: a pool made per request, whose connections every request adds (CAP-08). Counted at the database, in pg_stat_activity.` });
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
        message: `${r.method} ${route} ran \`${s.sql}\` ${s.times} times in one request with the same parameters (${s.params ?? 'none'}) and no write between: every run after the first reads what the request already has (DAT-06). From the statement log.` });
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
        message: `${r.method} ${route} ran \`${s.sql}\` on every request with the same parameters, nothing cached in front and no freshness lifetime in its Cache-Control, and its cost grows with the table: ${fmt(Math.round(b.blocks))} blocks a call at ${HI}x against ${fmt(Math.round(a.blocks))} at ${LO}x, for the same ${Math.round(b.rows)} row(s) (DAT-06).` });
    }
  }

  // ---- Memory kept per request (judge "memory", L05): the twin's heap
  // after a full collection, at each point of a soak whose requests each
  // carry a key of their own. Judged on the least-squares slope over the
  // points from the soak's first count on, which the counts put past every
  // bound the clean twin sets (MIN_POINTS or more), against the other twin's
  // slope on the same soak: a heap that keeps KEPT_BYTES or more a request,
  // and KEPT_RATIO times what the other twin's keeps, keeps something per
  // request that nothing removes (STB-05). The other twin's slope takes out
  // what both keep alike (code compiled late, pools, a bounded cache still
  // filling).
  const otherSoaks = spec.judge === 'memory' ? JSON.parse(readFileSync(join(outDir, twin === 'planted' ? 'clean' : 'planted', 'raw.json'), 'utf8')).scales[HI].soaks ?? [] : [];
  const soakSlope = (x, r) => slopeOf(x.points.filter((p) => p.requests >= r.counts[0]).map((p) => ({ x: p.requests, y: p.heapUsed })));
  for (const r of spec.judge === 'memory' ? spec.soaks : []) {
    const x = (hi.soaks ?? []).find((q) => q.id === r.id);
    const y = otherSoaks.find((q) => q.id === r.id);
    for (const [w, q] of [[twin, x], ['the other twin', y]]) if (!q || q.points.some((p) => !p.collected)) throw new Error(`${w}: soak ${r.id} has no heap measured after a full collection`);
    const mine = soakSlope(x, r);
    const theirs = soakSlope(y, r);
    if (mine.points < MIN_POINTS) throw new Error(`soak ${r.id}: ${mine.points} point(s) past ${r.counts[0]} requests, fewer than ${MIN_POINTS}`);
    const route = r.route ?? r.path;
    const ratio = mine.slope / Math.max(theirs.slope ?? 0, 1);
    const trace = { judge: 'memory', path: r.path, ratio, scales: x.points.map((p) => ({ scale: HI, requests: p.requests, heapBytesPerRequest: p.requests ? Number(((p.heapUsed - x.points[0].heapUsed) / p.requests).toFixed(1)) : 0 })) };
    if (mine.slope >= KEPT_BYTES && ratio >= KEPT_RATIO) emit({ check: 'memory-growth', rule: 'STB-05', strength: 'SHOULD', severity: 'warning', method: r.method, route, trace,
      message: `${r.method} ${route} kept about ${fmt(Math.round(mine.slope))} bytes of heap per request from request ${fmt(r.counts[0])} to ${fmt(r.counts.at(-1))} (least-squares slope over ${mine.points} points, R² ${mine.r2.toFixed(2)}), each with a key of its own, measured after a full collection, against ${fmt(Math.round(theirs.slope ?? 0))} for the twin without the defect: the heap grows with every new key and nothing gives it back (STB-05).` });
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
    // the cheapest route's extra in the same process after the warm-up, at
    // FIRST_RATIO times and FIRST_EXTRA_MS above it; no other twin needed.
    // Without one: the first request against the later ones of its start.
    const warm = x.samples.every((q) => Number.isFinite(q.extraMs));
    const wu = hi.warmup ?? null;
    const warmedBy = !wu ? '' : wu.source === 'fallback' ? ` after a request to a path that does not exist (${wu.method} ${wu.path}, a 404: it warms the framework, not the database driver)` : ` after a warm-up request to ${wu.method} ${wu.path} (from ${wu.source})`;
    const clears = warm
      ? x.samples.map((s) => s.extraMs >= FIRST_RATIO * s.baselineMs && s.extraMs - s.baselineMs >= FIRST_EXTRA_MS)
      : x.samples.map((s, k) => s.firstMs - later[k] >= FIRST_EXTRA_MS && s.firstMs >= FIRST_RATIO * later[k]);
    const env0 = { before: raw.environment?.before ?? environment(), after: raw.environment?.after ?? environment() };
    const firsts = x.samples.map((s) => (warm ? s.extraMs : s.firstMs));
    let v;
    if (rule === 'c') { const c = ruleC({ clears, samples: firsts, ...env0 }); if (!c.holds) continue; v = c.timing; }
    else { if (!clears.every(Boolean)) continue; v = timingJudge({ samples: firsts, ...env0 }); }
    const t = { ...v, why: Array.isArray(v.why) ? v.why.join('; ') || null : v.why ?? null };
    const route = r.route ?? r.path;
    const steady = median(later);
    const trace = { judge: 'timing', path: x.path, timing: t, ...(wu ? { warmup: { source: wu.source, method: wu.method, path: wu.path } } : {}), scales: [{ scale: HI, ms: Number(t.median.toFixed(1)) }] };
    if (t.reliable) emit({ check: 'cold-start', rule: 'STB-10', strength: 'SHOULD', severity: 'warning', method: r.method, route, trace,
      message: warm
        ? `${r.method} ${route}'s first request after a start took ${fmt(Math.round(t.median))} ms longer than the requests after it (median of ${x.samples.length} starts, spread ${(t.spread * 100).toFixed(1)}%), against ${fmt(Math.round(median(x.samples.map((q) => q.baselineMs))))} ms for the cheapest route in the same process${warmedBy}: the first request waits for set-up the start could have done (STB-10).`
        : `${r.method} ${route} took ${fmt(Math.round(t.median))} ms as the first request after a start (median of ${x.samples.length} starts, spread ${(t.spread * 100).toFixed(1)}%), against ${steady.toFixed(1)} ms for the requests after it: the first request waits for set-up the start could have done (STB-10).` });
    else emit({ check: 'cold-start', rule: 'STB-10', strength: 'SHOULD', severity: 'info', unresolved: true, method: r.method, route, trace,
      message: `${r.method} ${route}'s first request after a start looked slow, but timing unreliable: ${t.why}.` });
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
        message: `${r.method} ${route} read ${f.table} with a sequential scan, ${fmt(f.read)} rows of its ${fmt(f.size)} for the ${fmt(f.kept)} that pass ${f.filter}: PostgreSQL had no index to go to them directly (DAT-07). From auto_explain, on seeded data at ${HI}x.` });
    }
  }

  for (const f of out) {
    const errors = validate(extensionSchema, f.erlang);
    if (errors.length) throw new Error(`${twin}: ${f.fingerprint}: erlang extension: ${errors.join('; ')}`);
  }
  const r = report({
    specialist: 'erlang', version: VERSION, subject: relative(process.cwd(), subjectDir) || '.', started: new Date(raw.started ?? Date.now()),
    findings: out,
    run: { trace: { image: raw.image, fixture: raw.fixture, form: raw.form, twin, judge: spec.judge, ...(hi.warmup ? { warmup: hi.warmup } : {}), seed: raw.seed, scales: Object.fromEntries(Object.entries(raw.scales).map(([k, v]) => [k, { n: v.n, tables: v.tables }])) } },
  });
  if (rule === 'current') writeFileSync(join(outDir, twin, 'report.json'), JSON.stringify(r, null, 2) + '\n');
  return r;
}

const keyOf = (f) => `${f.check} ${f.rules?.[0] ?? ''} ${(f.where.endpoints ?? []).map((e) => `${e.method} ${e.route}`).join(',')}${f.erlang?.trace?.host ? ` ${f.erlang.trace.host}` : ''}`;
const matches = (d, f) => d.check === f.check && (!d.rule || f.rules?.includes(d.rule)) && (!d.host || f.erlang?.trace?.host === d.host)
  && ((f.where.endpoints ?? []).some((e) => e.method === d.method && e.route === d.route) || (!!d.symbol && f.erlang?.trace?.symbol === d.symbol));
// A form passes only when the planted twin yields a failing finding for
// every defect and the clean twin none. In a timed form (L09, L11), a defect
// the planted twin reports only as "timing unreliable" is not a pass: the
// form is UNRELIABLE (exit 3), unless something else failed (exit 1).
// Count-based forms never produce one.
let failed = false;
let unreliable = false;
const say = (ok, what, detail, status = ok ? 'PASS' : 'FAIL') => { if (status === 'FAIL') failed = true; if (status === 'UNRELIABLE') unreliable = true; console.log(`${status}  ${spec.fixture} ${spec.form} ${what}${detail ? `  (${detail})` : ''}`); };
const verdictOf = (t) => `samples ${JSON.stringify((t.samples ?? []).map((x) => Number(Number(x).toFixed(1))))}, spread ${t.spread == null ? 'unknown' : `${(t.spread * 100).toFixed(1)}%`}, load before ${t.before?.load1 ?? '?'}/${t.before?.cpus ?? '?'} CPUs, after ${t.after?.load1 ?? '?'}/${t.after?.cpus ?? '?'}: ${Array.isArray(t.why) ? t.why.join('; ') : t.why}`;
for (const twin of ['planted', 'clean']) {
  if (!existsSync(join(outDir, twin, 'raw.json'))) { say(false, twin, 'no raw.json: run scripts/trace.sh'); continue; }
  const r = judgeTwin(twin);
  const judged = r.findings.filter((f) => f.severity !== 'info');
  const infos = r.findings.filter((f) => f.severity === 'info').map(keyOf);
  const wu = r.erlang?.trace?.warmup;
  if (wu) console.log(`WARM-UP  ${spec.fixture} ${spec.form} ${twin}: ${wu.source === 'fallback' ? `fallback, ${wu.method} ${wu.path}, a path that does not exist (answered ${[...new Set(wu.runs.map((x) => x.status))].join(', ')}): warms the framework, not the database driver` : `configured in ${wu.source}, ${wu.method} ${wu.path} (answered ${[...new Set(wu.runs.map((x) => x.status))].join(', ')})`}`);
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
// Candidate rule (c) (Q8), timed judges only: the same run under each rule,
// one line per form, with the clean twin's failing findings and the decoys,
// and the measurements behind them. Printed only; the exit code is the
// current rule's.
if (['loop', 'starts'].includes(spec.judge) && ['planted', 'clean'].every((t) => existsSync(join(outDir, t, 'raw.json')))) {
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
  const outcome = (rule) => {
    const p = judgeTwin('planted', rule);
    const c = judgeTwin('clean', rule);
    const judged = p.findings.filter((f) => f.severity !== 'info');
    const unrel = spec.defects.filter((d) => !judged.some((f) => matches(d, f)) && p.findings.some((f) => f.severity === 'info' && matches(d, f) && f.erlang?.trace?.timing?.reliable === false));
    const missing = spec.defects.filter((d) => !judged.some((f) => matches(d, f)) && !unrel.includes(d));
    const extra = judged.filter((f) => !spec.defects.some((d) => matches(d, f)));
    const cleanFp = c.findings.filter((f) => f.severity !== 'info').length;
    const why = unrel.map((d) => `${d.method} ${d.route}: ${p.findings.find((f) => f.severity === 'info' && matches(d, f)).erlang.trace.timing.why}`);
    return { status: missing.length || extra.length || cleanFp ? 'FAIL' : unrel.length ? 'UNRELIABLE' : 'PASS', cleanFp, decoys: extra.length, missed: missing.map((d) => `${d.method} ${d.route}`), why };
  };
  const rules = [['current', 'current rule'], ['c', `(c) all or none of ${MIN_REPEATS}+ runs`]];
  const results = rules.map(([rule]) => outcome(rule));
  console.log(`TRIAL  ${spec.fixture} ${spec.form} trace: ${rules.map(([, name], k) => `${name} ${results[k].status} (clean false positives ${results[k].cleanFp}, decoys ${results[k].decoys}${results[k].missed.length ? `, missed ${results[k].missed.join(', ')}` : ''})`).join(' | ')}`);
  rules.forEach(([, name], k) => { for (const w of results[k].why) console.log(`      ${name}: ${w}`); });
}
process.exit(failed ? 1 : unreliable ? 3 : 0);
