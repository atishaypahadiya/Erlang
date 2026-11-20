// Trace judgements (research/trace-harness.md): pure functions over the counts
// scripts/trace/run.js records, so they are unit-tested without Docker and can
// be rerun on recorded data. Nothing here starts a process or opens a socket.

import { withoutMeasured } from './values.js';

// Starting values (research/trace-harness.md, decision 5), to tune on the
// planted and clean twins before any trace precision is published.
export const SLOPE = 0.5;        // statements (or calls) per extra item: grows
export const FIXED = 1.2;        // count at 10x over count at 1x, at most: fixed
export const ROWS = 5;           // rows at 10x over rows at 1x, at least: grows
export const COMPRESS_MIN = 1024; // bytes; @fastify/compress's and compression's default threshold
export const UNREAD = 0.5;       // share of a response's bytes its caller never reads

// A request template from trace.json, for n items: "$n" and "$i" (the item's
// 1-based index inside { $repeat }) become numbers when they are the whole
// string, and are substituted when they are part of one; "$list" becomes
// 1,2,...,n, for ids in a query string.
export function expand(t, n, i = null) {
  if (typeof t === 'string') {
    if (t === '$n') return n;
    if (t === '$i' && i !== null) return i;
    return t.replaceAll('$list', Array.from({ length: n }, (_, k) => k + 1).join(',')).replaceAll('$n', String(n)).replaceAll('$i', i === null ? '$i' : String(i));
  }
  if (Array.isArray(t)) return t.map((x) => expand(x, n, i));
  if (t && typeof t === 'object') {
    if ('$repeat' in t) {
      const count = t.$repeat === '$n' ? n : Number(t.$repeat);
      return Array.from({ length: count }, (_, k) => expand(t.item, n, k + 1));
    }
    return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, expand(v, n, i)]));
  }
  return t;
}

// SQL as pg_stat_statements and source code both write it, compared without
// case or spacing.
export const normalizeSql = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/;$/, '');

// The route a path was served by, from the routes the app registered; a
// route with fewer parameters wins, as in find-my-way.
export function routeOf(routes, method, path) {
  const segs = path.split('?')[0].split('/');
  const fits = routes.filter((r) => {
    if (r.method !== method) return false;
    const rs = r.url.split('/');
    return rs.length === segs.length && rs.every((s, k) => s.startsWith(':') || s === segs[k]);
  });
  fits.sort((a, b) => a.url.split(':').length - b.url.split(':').length);
  return fits[0]?.url ?? null;
}

// Whether a count grows with the items a request handles. n is null when the
// request handles a fixed number of items.
export function growth({ n1, n10, c1, c10 }) {
  const ratio = c1 ? c10 / c1 : c10 ? Infinity : 1;
  const k = n1 !== null && n10 !== null && n10 > n1 ? (c10 - c1) / (n10 - n1) : null;
  const verdict = k !== null && k >= SLOPE ? 'grows' : ratio <= FIXED ? 'fixed' : 'uncertain';
  return { verdict, k, ratio };
}

// Whether the rows a request reads grow with the table.
export function rowsGrowth({ r1, r10 }) {
  const ratio = r1 ? r10 / r1 : r10 ? Infinity : 1;
  return { verdict: ratio >= ROWS ? 'grows' : ratio <= FIXED ? 'bounded' : 'uncertain', ratio };
}

// The statement whose calls grow most between the two scales, from
// { query: { c1, c10 } }.
export function repeated(byQuery) {
  let best = null;
  for (const [query, { c1, c10 }] of Object.entries(byQuery).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!best || c10 - c1 > best.c10 - best.c1) best = { query, c1, c10 };
  }
  return best;
}

// Wraps parsed JSON so that every property a page reads is recorded in
// `read`, as a path: "name" at the root, "[]" for each item of an array,
// "[].name" for a property of each item.
export function track(value, read, path = '') {
  if (!value || typeof value !== 'object') return value;
  return new Proxy(value, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      if (typeof key !== 'string') return v;
      if (Array.isArray(target)) return /^\d+$/.test(key) ? track(v, read, `${path}[]`) : v;
      const p = path ? `${path}.${key}` : key;
      read.add(p);
      return track(v, read, p);
    },
  });
}

// The bytes of a JSON value that no read path reaches: each unread property,
// key and value, as JSON.stringify writes it.
export function unreadBytes(value, read, path = '') {
  if (Array.isArray(value)) return value.reduce((sum, v) => sum + unreadBytes(v, read, `${path}[]`), 0);
  if (!value || typeof value !== 'object') return 0;
  let sum = 0;
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    sum += read.has(p) ? unreadBytes(v, read, p) : Buffer.byteLength(`${JSON.stringify(k)}:${JSON.stringify(v)}`);
  }
  return sum;
}

// The property names a page never reads, at the top level of each item.
export function unreadFields(value, read, path = '') {
  if (Array.isArray(value)) return [...new Set(value.flatMap((v) => unreadFields(v, read, `${path}[]`)))].sort();
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value).filter((k) => !read.has(path ? `${path}.${k}` : k)).sort();
}

// A route as a pattern for source text: '/products/:id/price' matches
// '/products/${p.id}/price' in a caller and '/products/:id/price' in the
// handler, inside quotes or a template literal.
export function routePattern(route) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = route.split('/').map((s) => (s.startsWith(':') ? "[^/'\"`?]+" : esc(s))).join('/');
  return new RegExp(`['"\`]${body}['"\`?]`);
}

// Of the static findings, the one a trace finding confirms: the same check,
// the same method and route, and, when the trace names a statement, a
// location whose source line holds that statement. lineOf(file, line) reads a
// line of the subject.
export function linkStatic(t, statics, lineOf) {
  return statics.find((s) => s.check === t.check
    && (!t.rule || (s.rules ?? []).includes(t.rule))
    && (!t.symbol || (s.where.locations ?? []).some((l) => l.symbol === t.symbol))
    // A static finding with no endpoint (code no handler reaches, such as a
    // library) is matched by the symbol the trace names instead.
    && ((s.where.endpoints ?? []).length ? s.where.endpoints.some((e) => e.method === t.method && e.route === t.route) : !!t.symbol)
    // Prisma writes its own SQL, so its source holds a model call (or a
    // helper's name), never the statement: check, rule and endpoint decide.
    && (!t.statement || s.erlang?.client === 'prisma' || (s.where.locations ?? []).some((l) => normalizeSql(lineOf(l.file, l.line) ?? '').includes(normalizeSql(t.statement))))) ?? null;
}

export const fmt = (x) => (Number.isInteger(x) ? x.toLocaleString('en-GB') : x.toFixed(2));

// The least-squares slope of y on x over points [{ x, y }], with its R²: the
// heap slope (L05), bytes kept per request, in the trace and load forms.
export const MIN_POINTS = 5;
export function slopeOf(points) {
  const ps = (points ?? []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (ps.length < 2) return { slope: null, r2: null, points: ps.length };
  const mx = ps.reduce((a, p) => a + p.x, 0) / ps.length;
  const my = ps.reduce((a, p) => a + p.y, 0) / ps.length;
  const sxx = ps.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  const sxy = ps.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
  const syy = ps.reduce((a, p) => a + (p.y - my) ** 2, 0);
  if (!sxx) return { slope: null, r2: null, points: ps.length };
  return { slope: sxy / sxx, r2: syy ? (sxy * sxy) / (sxx * syy) : 0, points: ps.length };
}

// A measured run of a request names its measured fields, the ones that
// differ between runs of the same request (finding/1's mechanism, through
// lib/values.js withoutMeasured): its time, its bytes, the load average,
// the loop's stretches and the pool before it.
export const RUN_MEASURED = ['ms', 'bytes', 'load1', 'loop', 'poolBefore'];

// What two runs of one request must agree on to be judged: everything but
// their measured fields, with counts in place of lists (stub hits, connections
// opened, statements logged, calls per statement), the connections the
// request kept, and each plan's scans (scans(plans), given by the caller).
export function runShape(x, scans = (p) => p) {
  const kept = x.poolAfter && (x.poolAfter.total - x.poolAfter.idle) - (x.poolBefore.total - x.poolBefore.idle);
  const y = withoutMeasured(x);
  return JSON.stringify({ ...y, upstream: y.upstream?.length, poolAfter: kept, connections: y.connections?.opened, plans: y.plans && scans(y.plans), logged: y.logged?.length, statements: y.logged ? Object.fromEntries(Object.entries(y.statements).map(([q, v]) => [q, v.calls])) : y.statements });
}

// A trace defect (trace.json "defects": { check, rule, method, route, host,
// symbol }) and a finding: the same check and rule, on the defect's endpoint
// (or its symbol), and its host when it names one. Used by the trace judge
// and by the release gate (scripts/compare-reports.js).
export const defectMatches = (d, f) => d.check === f.check && (!d.rule || f.rules?.includes(d.rule)) && (!d.host || f.erlang?.trace?.host === d.host)
  && ((f.where?.endpoints ?? []).some((e) => e.method === d.method && e.route === d.route) || (!!d.symbol && f.erlang?.trace?.symbol === d.symbol));
