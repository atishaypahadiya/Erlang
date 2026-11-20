// Records the counts for one fixture form (research/trace-harness.md). Run by
// scripts/trace.sh, which starts PostgreSQL and passes it in the environment;
// not meant to be run alone.
//
// For each twin, at each scale (1x and 10x): a fresh database, the form's
// trace/schema.sql and trace/seed.sql (psql variable :scale), then the twin
// served on 127.0.0.1 by scripts/trace/serve.js, and every request in
// trace/trace.json sent three times, one after another: a warm-up, then two
// measured. pg_stat_statements is reset before each request and read after
// its response, counting only the app's role and only top-level statements,
// so everything counted is a statement that request sent. Page views (trace.json "pages") run the twin's own page
// code against the twin, counting its calls and the fields it reads.
//
// Every outbound call the twin makes goes to a stub on 127.0.0.1 run here
// (scripts/trace/serve.js redirects them). A request's "upstream" says how
// the stub answers while it runs: { status, body, delayMs }, or { hang: true }
// to accept and never answer, and per host under "hosts" ({ host: answer }).
// What the stub receives is recorded per
// request, with times. "probes" asks the twin, over IPC, for its pool counts
// while the stub is answering ("pool-during") and after the response
// ("pool-after"), and for the event loop's delay over the request ("loop").
// "timeoutMs" is how long the harness waits before giving up on a response,
// recorded as timedOut. Other measurements, each optional in trace.json:
//   "repeats": a request sent k times in a row with no reset between, for
//     statements that every request repeats;
//   "soaks": a request with a unique key ($i) sent n times, the twin's heap
//     after a full collection read before and after;
//   "starts": the first requests after the twin starts, against later ones,
//     restarting the twin for each sample.
//
// Usage: node scripts/trace/run.js <form dir> <out dir> <node_modules dir>
// Environment: ERLANG_TRACE_CONTAINER, ERLANG_TRACE_PORT, ERLANG_TRACE_APP_PASSWORD_FILE.
// Writes <out dir>/<twin>/raw.json and the twin's log.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, symlinkSync, existsSync, openSync, closeSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request as httpRequest, createServer } from 'node:http';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { expand, routeOf, track, unreadBytes, unreadFields } from '../../lib/trace-judge.js';
import { environment } from '../../lib/timing.js';
import { warmupFor } from '../../lib/scope.js';
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
import { waitForNoLock, active, describe as describeLock, EXIT_LOCKED } from '../../lib/itten-lock.js';
import { CAPS, profile, checkRun, checkStep, Refused } from '../../lib/load-guard.js';
import { scenario } from '../../lib/k6-scenario.js';
import { exitOnCrash } from '../../lib/crash.js';

exitOnCrash('trace');

const HERE = dirname(fileURLToPath(import.meta.url));
// --load: the load harness (scripts/load.sh, research/load-harness.md), which
// shares this runner: the form's load/load.json steps, run by k6, over the
// same database, seed and served twin.
// --headroom: the load form's clean twin, its main-thread time per request
// at each step (headroomMain, below); set up as a load run is.
const HEADROOM = process.argv.includes('--headroom');
const LOAD = process.argv.includes('--load') || HEADROOM;
// How many times one twin's repeat is run again after ITTEN's lock
// interrupts it, before the run stops with exit 75.
const LOAD_ATTEMPTS = 5;
const [formDir, outDir, modules] = process.argv.slice(2).filter((a) => a !== '--load' && a !== '--headroom').map((p) => p && resolve(p));
const { ERLANG_TRACE_CONTAINER: CONTAINER, ERLANG_TRACE_PORT: PORT, ERLANG_TRACE_APP_PASSWORD_FILE: PW_FILE } = process.env;
if (!formDir || !outDir || !modules || !CONTAINER || !PORT || !PW_FILE) {
  console.error('usage: node scripts/trace/run.js <form dir> <out dir> <node_modules dir>, with ERLANG_TRACE_CONTAINER, ERLANG_TRACE_PORT and ERLANG_TRACE_APP_PASSWORD_FILE set (scripts/trace.sh sets them)');
  process.exit(64);
}
const DB = 'erlang_trace';
const ROLE = 'erlang_app';
const MIN_GAP_MS = 200; // at most 5 requests a second
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
// A setup file (seed.sql, schema.sql, overlay/): the load form's own when it
// has one, else the trace form's.
const setup = (name) => (LOAD && existsSync(join(formDir, 'load', name)) ? join(formDir, 'load', name)
  : !existsSync(join(formDir, 'trace', name)) && twinsRoot !== formDir && existsSync(join(twinsRoot, 'trace', name)) ? join(twinsRoot, 'trace', name)
    : join(formDir, 'trace', name));
const spec = LOAD
  ? { ...(existsSync(join(formDir, 'trace', 'trace.json')) ? readJson(join(formDir, 'trace', 'trace.json')) : {}), requests: [], pages: [], soaks: [], starts: null, ...readJson(join(formDir, 'load', 'load.json')) }
  : readJson(join(formDir, 'trace', 'trace.json'));
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
// Where the twins are: the form's own folder, or, when trace.json names
// "twins" (a folder relative to the form, inside fixtures/), another form's
// (L11's fallback form runs L11's twins with no warm-up route).
const warmupOf = (twinDir) => warmupFor(spec.warmup, twinDir);
const twinsRoot = (() => {
  if (!spec.twins) return formDir;
  const at = resolve(formDir, spec.twins);
  const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
  if (!at.startsWith(fixtures + '/')) throw new Error(`trace.json: twins ${spec.twins} is outside fixtures/`);
  return at;
})();


// psql inside the container, over its local socket; SQL goes on stdin, never
// on a command line.
// The app role's backends at the database, by pid: a connection a request
// opened shows as a pid that was not there before it.
function backends() {
  const out = psql('postgres', 'postgres', `select pid from pg_stat_activity where usename = '${ROLE}' and datname = '${DB}' order by pid;\n`);
  return out ? out.split('\n').map(Number) : [];
}

function psql(user, db, sql, vars = {}) {
  const args = ['exec', '-i', CONTAINER, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  return execFileSync('docker', args, { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// The schema: the form's trace/schema.sql, or, with "schema": "twin:<dir>",
// the twin's own migrations in that directory, in name order.
// With "schema": "twin:prisma", the twin's prisma/schema.prisma, rendered
// to SQL by the installed Prisma CLI (prisma migrate diff, which connects to
// nothing) into the twin's output folder.
const schemaFiles = (twinDir) => spec.schema === 'twin:prisma'
  ? [join(twinDir, 'prisma', 'schema.prisma')]
  : spec.schema?.startsWith('twin:')
    ? readdirSync(join(twinDir, spec.schema.slice(5))).filter((f) => f.endsWith('.sql')).sort().map((f) => join(twinDir, spec.schema.slice(5), f))
    : [setup('schema.sql')];
const prismaSqlOf = new Map();
function prismaSql(schema, out) {
  const install = dirname(modules);
  const sql = join(out, 'schema.sql');
  const r = spawnSync(join(modules, '.bin', 'prisma'), ['migrate', 'diff', '--from-empty', '--to-schema', schema, '--script', '-o', sql, '--config', join(install, 'prisma.config.ts')], { cwd: install, encoding: 'utf8', env: { ...process.env, CHECKPOINT_DISABLE: '1' } });
  if (r.status !== 0 || !existsSync(sql) || !statSync(sql).size) throw new Error(`prisma migrate diff gave no SQL for ${schema}: ${r.stderr || r.stdout}`);
  // The role owns its database, not the public schema's creation.
  return readFileSync(sql, 'utf8').replace(/^CREATE SCHEMA IF NOT EXISTS "public";$/m, '');
}

function freshDatabase(scale, twinDir) {
  psql('postgres', 'postgres', `drop database if exists ${DB} with (force);\ncreate database ${DB} owner ${ROLE};\n`);
  psql('postgres', DB, 'create extension pg_stat_statements;\n');
  for (const f of schemaFiles(twinDir)) {
    if (f.endsWith('.prisma')) {
      const out = join(outDir, basename(twinDir));
      mkdirSync(out, { recursive: true });
      prismaSqlOf.set(f, prismaSqlOf.get(f) ?? prismaSql(f, out));
      psql(ROLE, DB, prismaSqlOf.get(f));
    } else psql(ROLE, DB, readFileSync(f, 'utf8'));
  }
  psql(ROLE, DB, readFileSync(setup('seed.sql'), 'utf8'), { scale });
  psql(ROLE, DB, 'analyze;\n');
  const counts = psql(ROLE, DB, "select format('select %L, count(*) from %I', table_name, table_name) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1\n\\gexec\n");
  return Object.fromEntries(counts.split('\n').filter(Boolean).map((l) => { const [t, c] = l.split('|'); return [t, Number(c)]; }));
}

const resetStats = () => psql('postgres', DB, 'select pg_stat_statements_reset();\n');

// Statements with their parameters (trace.json "params"): the app role logs
// every statement (log_statement, set for the role in the trace database
// only), and a request's are the ones between two markers the harness logs
// as postgres around it. In order, as { sql, params }.
let markSeq = 0;
function mark() {
  const m = `erlang-mark-${process.pid}-${++markSeq}`;
  psql('postgres', DB, `set log_statement = 'all';\nselect '${m}';\n`);
  return m;
}
const ENTRY = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)? \S+ \[(\d+)\] (\w+):\s+(.*)$/;
function loggedBetween(start, end, sinceIso) {
  // PostgreSQL logs to stderr, which docker logs writes to its own stderr.
  const r = spawnSync('docker', ['logs', '--since', sinceIso, CONTAINER], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`trace: docker logs failed: ${r.stderr.slice(0, 200)}`);
  const all = `${r.stdout}\n${r.stderr}`;
  const entries = [];
  for (const line of all.split('\n')) {
    const m = ENTRY.exec(line);
    if (m) entries.push({ pid: m[1], level: m[2], text: m[3] });
    else if (entries.length && /^\s/.test(line)) entries.at(-1).text += `\n${line.trim()}`;
  }
  const a = entries.findIndex((e) => e.text.includes(start));
  const b = entries.findIndex((e, k) => k > a && e.text.includes(end));
  if (a < 0 || b < 0) throw new Error('trace: the statement log has no markers around the request');
  const out = [];
  const plans = [];
  const markPids = new Set([entries[a].pid, entries[b].pid]);
  for (const e of entries.slice(a + 1, b)) {
    if (markPids.has(e.pid)) continue;
    const p = /^duration: [\d.]+ ms\s+plan:\s*([\s\S]*)$/.exec(e.text);
    if (e.level === 'LOG' && p) { try { plans.push(JSON.parse(p[1])); } catch { throw new Error('trace: a plan in the log is not JSON'); } continue; }
    const s = /^(?:statement|execute [^:]*):\s+([\s\S]*)$/.exec(e.text);
    if (e.level === 'LOG' && s) out.push({ pid: e.pid, sql: s[1].trim(), params: null });
    else if (e.level === 'DETAIL' && /^Parameters: /.test(e.text)) { const last = out.findLast((o) => o.pid === e.pid); if (last) last.params = e.text.slice('Parameters: '.length); }
  }
  return { statements: out.map(({ sql, params }) => ({ sql, params })), plans };
}

// The statements the app's role ran since the reset: { query: { calls, rows } }.
// Per statement: calls and rows, and, for a form that asks for parameters
// (trace.json "params"), the blocks it touched (shared hit + read).
function readStats() {
  // Blocks (shared hit + read) for a form that asks for parameters, and in
  // every load run (rows and blocks per request, L02 and L03).
  const json = psql('postgres', DB, `select coalesce(json_object_agg(query, json_build_object('calls', calls, 'rows', rows${spec.params || LOAD ? ", 'blocks', blocks" : ''})), '{}')
from (select s.query, sum(s.calls)::int as calls, sum(s.rows)::int as rows, sum(s.shared_blks_hit + s.shared_blks_read)::int as blocks
      from pg_stat_statements s join pg_roles r on r.oid = s.userid join pg_database d on d.oid = s.dbid
      where s.toplevel and r.rolname = '${ROLE}' and d.datname = '${DB}' group by s.query) q;\n`);
  return JSON.parse(json);
}

// One HTTP request to the twin, offering compression, with the bytes as sent.
function send(port, method, path, body, timeoutMs = 30_000) {
  return new Promise((ok, fail) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'accept-encoding': 'gzip, br', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
      res.on('error', fail);
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`${method} ${path}: no response in ${timeoutMs} ms`), { code: 'ERLANG_TIMEOUT' })));
    req.on('error', fail);
    req.end(data);
  });
}

// The stub every outbound call of the twin reaches.
const stub = { conf: {}, hits: [], open: new Set(), onHit: null };
const stubServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const hit = { host: req.headers['x-erlang-host'] ?? null, method: req.method, path: req.url, at: Number(process.hrtime.bigint() / 1000n) / 1000 };
    stub.hits.push(hit);
    if (stub.onHit) { try { hit.probe = await stub.onHit(hit); } catch (e) { hit.probe = { error: String(e.message) }; } }
    const c = stub.conf.hosts?.[hit.host] ?? stub.conf;
    if (c.hang) { stub.open.add(res); res.on('close', () => stub.open.delete(res)); return; }
    const answer = () => {
      res.writeHead(c.status ?? 200, { 'content-type': 'application/json', ...(c.status === 503 || c.status === 429 ? { 'retry-after': '1' } : {}) });
      res.end(JSON.stringify(c.body ?? {}));
    };
    if (c.delayMs) setTimeout(answer, c.delayMs); else answer();
  });
});
await new Promise((ok) => stubServer.listen({ host: '127.0.0.1', port: 0 }, ok));
const STUB = `127.0.0.1:${stubServer.address().port}`;
function stubFor(conf = {}) {
  for (const r of stub.open) r.destroy();
  stub.open.clear();
  stub.conf = conf;
  stub.hits = [];
  stub.onHit = null;
}

function decode(res) {
  const enc = res.headers['content-encoding'];
  const text = (enc === 'gzip' ? gunzipSync(res.raw) : enc === 'br' ? brotliDecompressSync(res.raw) : enc === 'deflate' ? inflateSync(res.raw) : res.raw).toString('utf8');
  const type = res.headers['content-type'] ?? '';
  return { text, json: type.includes('json') && text ? JSON.parse(text) : undefined };
}

const at = (obj, path) => path.split('.').reduce((v, k) => v?.[k], obj);
function itemsOf(how, body, decoded) {
  if (!how) return null;
  if (how === 'ndjson') return decoded.text.split('\n').filter(Boolean).length;
  const [from, ...rest] = how.split('.');
  const v = from === 'response' ? (rest.length ? at(decoded.json, rest.join('.')) : decoded.json) : at(body, rest.join('.'));
  if (!Array.isArray(v)) throw new Error(`items: ${how} is not a list`);
  return v.length;
}

let last = 0;
const SOAK_GAP_MS = 20;
async function paced(gap = MIN_GAP_MS) {
  const wait = last + gap - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
}

// The scan nodes of a request's plans, as "<node> on <table>", for telling
// whether two runs chose the same plans.
function scans(plans) {
  const out = [];
  const walk = (n) => { if (n['Relation Name']) out.push(`${n['Node Type']} on ${n['Relation Name']}`); for (const c of n.Plans ?? []) walk(c); };
  for (const p of plans) walk(p.Plan);
  return out;
}

// One request, with the stub and probes as the request asks; a response
// that does not come within timeoutMs is recorded as timedOut.
async function once(app, r, path, body) {
  stubFor(r.upstream);
  const probes = r.probes ?? [];
  if (probes.includes('pool-during')) stub.onHit = () => app.probe('pool');
  if (probes.includes('loop')) await app.probe('loop-reset');
  // The waits the twin declares (L06's attempts): every timer it sets during
  // the request, on the stub's clock.
  const timed = spec.judge === 'attempts' && !!r.upstream;
  if (timed) await app.probe('timers-reset');
  const poolBefore = probes.includes('pool-after') ? await app.probe('pool') : null;
  const backendsBefore = probes.includes('connections') ? backends() : null;
  const since = new Date(Date.now() - 5000).toISOString();
  const markStart = spec.params || spec.plans ? mark() : null;
  const t0 = performance.now();
  let res = null;
  let timedOut = false;
  try { res = await send(app.port, r.method, path, body, r.timeoutMs); } catch (e) { if (e.code === 'ERLANG_TIMEOUT') timedOut = true; else throw e; }
  const ms = performance.now() - t0;
  const fromLog = markStart ? loggedBetween(markStart, mark(), since) : null;
  const logged = spec.params ? fromLog.statements : null;
  const plans = spec.plans ? fromLog.plans : null;
  const base0 = stub.hits[0]?.at ?? 0;
  const hits = stub.hits.map((h) => ({ ...h, at: Number((h.at - base0).toFixed(3)) }));
  const timers = timed ? ((await app.probe('timers')).timers ?? []).map((t) => ({ ms: t.ms, at: Number((t.at - base0).toFixed(3)) })) : null;
  const extra = {
    ...(r.upstream || hits.length ? { upstream: hits } : {}),
    ...(timers ? { timers } : {}),
    ...(probes.includes('pool-after') ? { poolBefore, poolAfter: await app.probe('pool') } : {}),
    ...(probes.includes('loop') ? { loop: await app.probe('loop') } : {}),
    ...(backendsBefore ? (() => { const after = backends(); return { connections: { opened: after.filter((p) => !backendsBefore.includes(p)).length, open: after.length } }; })() : {}),
    ms: Number(ms.toFixed(3)),
    ...(plans ? { plans } : {}),
    ...(logged ? { logged, cacheHeaders: res ? { cacheControl: res.headers['cache-control'] ?? null, etag: res.headers.etag ?? null } : null } : {}),
  };
  stubFor();
  return { res, timedOut, extra };
}

async function measureRequest(app, r, n) {
  const path = expand(r.path, n);
  const body = r.body === undefined ? undefined : expand(r.body, n);
  const runs = [];
  // Three runs, the first a warm-up; two when trace.json says so (runs: 2),
  // for requests that wait out a timeout; more for timings (L09: six, five
  // after the warm-up, as the relative timing rule needs).
  const count = r.runs ?? spec.runs ?? 3;
  for (let k = 0; k < count; k++) {
    await paced();
    resetStats();
    // "$run" in the body: this run's index, for values that must differ per
    // run (a unique email).
    const sent = body === undefined || !JSON.stringify(body).includes('$run') ? body : JSON.parse(JSON.stringify(body).replaceAll('$run', String(k)));
    const { res, timedOut, extra } = await once(app, r, path, sent);
    const stats = readStats();
    const decoded = res ? decode(res) : { text: '', json: undefined };
    runs.push({
      status: res?.status ?? null,
      timedOut,
      bytes: res?.raw.length ?? 0,
      encoding: res?.headers['content-encoding'] ?? null,
      contentType: res?.headers['content-type'] ?? null,
      streamed: res ? res.headers['content-length'] === undefined : false,
      items: res ? itemsOf(r.items, body, decoded) : null,
      statements: stats,
      ...extra,
    });
  }
  const w = count >= 3 ? runs[0] : null;
  const [a, b] = runs.slice(-2);
  const kept = (x) => x.poolAfter && (x.poolAfter.total - x.poolAfter.idle) - (x.poolBefore.total - x.poolBefore.idle);
  const shape = (x) => JSON.stringify({ ...x, bytes: 0, ms: 0, upstream: x.upstream?.length, loop: undefined, poolBefore: undefined, poolAfter: kept(x), connections: x.connections?.opened, plans: x.plans && scans(x.plans), logged: x.logged?.length, statements: x.logged ? Object.fromEntries(Object.entries(x.statements).map(([q, v]) => [q, v.calls])) : x.statements });
  const stable = shape(a) === shape(b);
  const keep = (x) => ({ timedOut: x.timedOut, ...(x.upstream ? { upstream: x.upstream } : {}), ...(x.timers ? { timers: x.timers } : {}), ...(x.poolAfter ? { poolBefore: x.poolBefore, poolAfter: x.poolAfter } : {}), ms: x.ms, ...(x.loop ? { loop: x.loop } : {}), ...(x.connections ? { connections: x.connections } : {}), ...(x.logged ? { logged: x.logged, cacheHeaders: x.cacheHeaders, statements: x.statements } : {}), ...(x.plans ? { plans: x.plans } : {}) });
  return { id: r.id, method: r.method, path, route: r.route ?? routeOf(app.routes, r.method, path), ...b, stable, ...(stable ? {} : { other: a }), ...(r.upstream || r.probes || spec.params || spec.plans ? { ...(w ? { warm: keep(w) } : {}), first: keep(a), last: keep(b) } : {}), samples: runs.map((x) => ({ ms: x.ms, ...(x.loop ? { loopMaxMs: x.loop.maxMs } : {}), ...(x.upstream ? { attempts: x.upstream.length } : {}) })) };
}

// The same request k times in a row, statements counted over all of them.
async function measureRepeat(app, r, n) {
  const path = expand(r.path, n);
  await paced();
  await once(app, r, path); // warm-up, outside the count
  resetStats();
  for (let k = 0; k < r.times; k++) { await paced(); const { res } = await once(app, r, path); if (!res || res.status >= 400) throw new Error(`${r.method} ${path} answered ${res?.status ?? 'nothing'} in repeat ${r.id}`); }
  return { id: r.id, method: r.method, path, route: r.route ?? routeOf(app.routes, r.method, path), times: r.times, statements: readStats() };
}

// The twin's heap after a full collection, before and after n requests each
// with a key ($i) of its own.
async function measureSoak(app, r) {
  const points = [{ requests: 0, ...(await app.probe('memory')) }];
  let sent = 0;
  for (const target of r.counts) {
    // Soaks are paced at most 50 requests a second, still one at a time.
    for (; sent < target; sent++) { await paced(SOAK_GAP_MS); const { res } = await once(app, r, expand(r.path, 0, sent), r.body === undefined ? undefined : expand(r.body, 0, sent)); if (!res || res.status >= 400) throw new Error(`soak ${r.id}: ${r.method} answered ${res?.status ?? 'nothing'}`); }
    points.push({ requests: sent, ...(await app.probe('memory')) });
  }
  return { id: r.id, method: r.method, route: r.route ?? null, points };
}

async function measurePage({ port, routes }, page, work, n) {
  const mod = await import(pathToFileURL(join(work, page.module)).href);
  const calls = [];
  const api = {
    async get(path) {
      await paced();
      const res = await send(port, 'GET', path);
      const decoded = decode(res);
      const call = { method: 'GET', path, route: routeOf(routes, 'GET', path), status: res.status, bytes: res.raw.length, encoding: res.headers['content-encoding'] ?? null, contentType: res.headers['content-type'] ?? null, json: decoded.json, read: new Set() };
      calls.push(call);
      return track(decoded.json, call.read);
    },
  };
  const result = await mod[page.export](api, ...expand(page.args ?? [], n));
  return {
    id: page.id,
    items: Array.isArray(result) ? result.length : null,
    calls: calls.map(({ json, read, ...c }) => ({ ...c, jsonBytes: Buffer.byteLength(JSON.stringify(json ?? null)), unreadBytes: unreadBytes(json, read), unreadFields: unreadFields(json, read) })),
  };
}

async function serve(work, scale, log) {
  const ready = join(outDir, `ready-${process.pid}.json`);
  rmSync(ready, { force: true });
  const password = readFileSync(PW_FILE, 'utf8').trim();
  const fd = openSync(log, 'a');
  const url = `postgres://${ROLE}:${encodeURIComponent(password)}@127.0.0.1:${PORT}/${DB}`;
  if (spec.params) psql('postgres', 'postgres', `alter role ${ROLE} in database ${DB} set log_statement = 'all';\n`);
  // Plans (trace.json "plans"): auto_explain, loaded in the app role's
  // sessions in the trace database only, logs every statement's plan as run.
  if (spec.plans) psql('postgres', 'postgres', ['session_preload_libraries = \'auto_explain\'', 'auto_explain.log_min_duration = 0', 'auto_explain.log_analyze = on', 'auto_explain.log_timing = off', 'auto_explain.log_format = json'].map((g) => `alter role ${ROLE} in database ${DB} set ${g};\n`).join(''));
  const child = spawn(process.execPath, ['--expose-gc', join(HERE, 'serve.js'), work, ready, spec.entry ?? ''], {
    env: { ...Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, v === '$DATABASE_URL' ? url : v])), PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_URL: url, ERLANG_TRACE_STUB: STUB },
    stdio: ['ignore', fd, fd, 'ipc'],
  });
  let seq = 0;
  const waiting = new Map();
  child.on('message', (m) => { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } });
  const probe = (name) => new Promise((ok, fail) => {
    const id = ++seq;
    const t = setTimeout(() => { waiting.delete(id); fail(new Error(`probe ${name}: no answer in 10 s`)); }, 10_000);
    waiting.set(id, (m) => { clearTimeout(t); const { id: _, ...rest } = m; ok(rest); });
    child.send({ id, probe: name });
  });
  closeSync(fd);
  let exited = null;
  child.on('exit', (code) => { exited = code ?? 'signal'; });
  for (let t = 0; t < 200 && !existsSync(ready); t++) {
    if (exited !== null) throw new Error(`the twin exited (${exited}) before listening at ${scale}x; see ${log}`);
    await sleep(100);
  }
  if (!existsSync(ready)) { child.kill('SIGKILL'); throw new Error(`the twin did not listen within 20 s at ${scale}x; see ${log}`); }
  const info = JSON.parse(readFileSync(ready, 'utf8'));
  rmSync(ready);
  return { ...info, probe, stop: () => new Promise((ok) => { if (exited !== null) return ok(); child.once('exit', ok); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }) };
}

if (LOAD) {
  if (HEADROOM) await headroomMain(); else await loadMain();
  stubFor();
  await new Promise((ok) => stubServer.close(ok));
  process.exit(0);
}

for (const twin of ['planted', 'clean']) {
  // ITTEN's timing lock, reread immediately before each twin starts.
  const held = await waitForNoLock({ label: `trace ${spec.fixture} ${spec.form} ${twin}`, limitMs: 1000 * Number(process.env.ERLANG_LOCK_WAIT_S ?? 600), onWait: (l) => console.error(`trace: waiting for ITTEN's timing lock: ${describeLock(l)}`) });
  if (held) {
    console.error(`trace: ITTEN's timing lock is still active; not starting the ${twin} twin. ${describeLock(held)}`);
    process.exit(EXIT_LOCKED);
  }
  const out = join(outDir, twin);
  const work = join(out, 'work');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(twinsRoot, twin), work, { recursive: true });
  // Trace-only files (a driver for a library with no server) go over the twin.
  // The twins' own form's overlay first, when the twins are another form's,
  // then this form's on top (L11's fallback form replaces only the entry).
  if (twinsRoot !== formDir && existsSync(join(twinsRoot, 'trace', 'overlay'))) cpSync(join(twinsRoot, 'trace', 'overlay'), work, { recursive: true });
  if (existsSync(join(formDir, 'trace', 'overlay'))) cpSync(join(formDir, 'trace', 'overlay'), work, { recursive: true });
  symlinkSync(modules, join(work, 'node_modules'), 'dir');
  const log = join(out, 'twin.log');
  const raw = { image: process.env.ERLANG_TRACE_IMAGE ?? null, started: new Date().toISOString(), environment: { before: environment() }, fixture: spec.fixture, form: spec.form, twin, seed: { schema: Object.fromEntries(schemaFiles(join(twinsRoot, twin)).map((f) => [f.slice(twinsRoot.length + 1), sha256(f)])), seed: sha256(setup('seed.sql')) }, scales: {} };
  for (const scale of spec.scales) {
    const n = spec.n * scale;
    const tables = freshDatabase(scale, join(twinsRoot, twin));
    let app = await serve(work, scale, log);
    try {
      const requests = [];
      for (const r of spec.requests ?? []) {
        // A request that leaves state behind (a leaked connection) gets a
        // twin of its own.
        if (r.restart) { await app.stop(); app = await serve(work, scale, log); }
        requests.push(await measureRequest(app, r, n));
      }
      const pages = [];
      for (const p of spec.pages ?? []) pages.push(await measurePage(app, p, work, n));
      const repeats = [];
      for (const r of spec.repeats ?? []) repeats.push(await measureRepeat(app, r, n));
      const soaks = [];
      for (const r of scale === spec.scales.at(-1) ? spec.soaks ?? [] : []) soaks.push(await measureSoak(app, r));
      raw.scales[scale] = { n, tables, requests, pages, ...(repeats.length ? { repeats } : {}), ...(soaks.length ? { soaks } : {}) };
    } finally {
      await app.stop();
    }
    // The first requests after a start, against later ones, one start per sample.
    if (spec.starts && scale === spec.scales.at(-1)) {
      // With a warm-up (L11): every route's first request in one fresh
      // process per start, after one request to a neutral route, the routes
      // in an order rotated by one each start so no route always comes
      // first. Each route's first-request extra (its first request minus the
      // median of the ones after it) is judged against the cheapest route's
      // extra in the same process, the baseline; no other twin is needed.
      // The warm-up: the form's own (trace.json "warmup", a route its overlay
      // adds), else the app's (erlang.config.json "warmup"), else a path
      // that does not exist, expected to answer 404: that warms the
      // framework but not the database driver. The report says which ran.
      const warmup = warmupOf(join(twinsRoot, twin));
      const count = Math.max(...spec.starts.map((r) => r.samples ?? 5));
      const warmups = [];
      const byRoute = new Map(spec.starts.map((r) => [r.id, []]));
      for (let k = 0; k < count; k++) {
        const fresh = await serve(work, scale, log);
        try {
          await paced();
          const w = await once(fresh, warmup, warmup.path);
          const status = w.res?.status ?? null;
          if (warmup.source === 'fallback' ? status === null || status >= 500 : status === null || status >= 400) throw new Error(`warm-up ${warmup.method} ${warmup.path} (${warmup.source}) answered ${status ?? 'nothing'}`);
          warmups.push({ status, ms: w.extra.ms });
          const order = spec.starts.map((_, j) => spec.starts[(j + k) % spec.starts.length]);
          const seen = [];
          for (const [position, r] of order.entries()) {
            const runs = [];
            for (let j = 0; j < (r.after ?? 5) + 1; j++) { await paced(); const { res, extra } = await once(fresh, r, expand(r.path, n), r.body === undefined ? undefined : expand(r.body, n)); if (!res || res.status >= 400) throw new Error(`start ${r.id}: ${r.method} answered ${res?.status ?? 'nothing'}`); runs.push({ ms: extra.ms }); }
            const later = runs.slice(1).map((x) => x.ms);
            seen.push({ id: r.id, sample: { start: k, position, warmupMs: w.extra.ms, firstMs: runs[0].ms, laterMs: later, extraMs: runs[0].ms - median(later) } });
          }
          // The baseline: the cheapest route's extra in this process; with
          // the 404 fallback, the 404 request's own time (the owner, 19
          // November 2026): no route is warmed, so the cheapest route's extra
          // can be 0 and the bar would fall to FIRST_EXTRA_MS alone.
          const fallback = warmup.source === 'fallback';
          const baseline = fallback ? w.extra.ms : Math.max(0, Math.min(...seen.map((x) => x.sample.extraMs)));
          for (const x of seen) byRoute.get(x.id).push({ ...x.sample, baselineMs: baseline, baselineOf: fallback ? 'warm-up' : 'cheapest route' });
        } finally { await fresh.stop(); }
      }
      raw.scales[scale].starts = spec.starts.map((r) => ({ id: r.id, method: r.method, path: expand(r.path, n), route: r.route ?? null, samples: byRoute.get(r.id) }));
      raw.scales[scale].warmup = { ...warmup, runs: warmups };
    }
    console.log(`trace: ${spec.fixture} ${spec.form} ${twin} at ${scale}x: ${(spec.requests ?? []).length} request(s), ${(spec.pages ?? []).length} page view(s)`);
  }
  rmSync(work, { recursive: true, force: true });
  raw.environment.after = environment();
  writeFileSync(join(out, 'raw.json'), JSON.stringify(raw, null, 2) + '\n');
}
stubFor();
await new Promise((ok) => stubServer.close(ok));

// ---- The load harness (--load). For each repeat, the planted twin and then
// the clean one, each fresh, each step run by k6 at a fixed arrival rate.
// ITTEN's lock is read before each step and every 5 s during it; the load
// average is read before each step and, after it, once the harness's own
// load has stopped and the average has fallen below half the CPU count (up
// to 120 s; docs/decisions.md, Q6).
async function loadMain() {
  const mode = profile();
  const caps = CAPS[mode];
  // Pairs: the form's repeats, or ERLANG_LOAD_PAIRS when more (CI runs five
  // a form), the twins in alternating order.
  // Pair k runs the twins in turn, planted first when k is even, clean first
  // when odd, so drift over the run falls on both alike.
  const pairs = Math.max(Number(process.env.ERLANG_LOAD_PAIRS) || 0, spec.repeats || 3);
  spec.repeats = pairs;
  try { checkRun(spec, caps); } catch (e) { if (e instanceof Refused) { console.error(`load: refused: ${e.message}`); process.exit(2); } throw e; }
  const k6 = process.env.ERLANG_K6 || 'k6';
  const v = spawnSync(k6, ['version'], { encoding: 'utf8' });
  if (v.status !== 0) { console.error('load: k6 is not on the path. Install it from https://grafana.com/docs/k6/latest/set-up/install-k6/ (ERLANG runs it as a separate program and does not install it), or set ERLANG_K6 to its path.'); process.exit(2); }
  const lockWait = 1000 * Number(process.env.ERLANG_LOCK_WAIT_S ?? 600);
  const scale = spec.scale ?? 1;
  const raw = { profile: mode, caps, k6: v.stdout.trim().split('\n')[0], image: process.env.ERLANG_TRACE_IMAGE ?? null, started: new Date().toISOString(), fixture: spec.fixture, form: spec.form, scale, repeats: [] };
  const works = {};
  for (const twin of ['planted', 'clean']) {
    const out = join(outDir, twin);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const work = join(out, 'work');
    cpSync(join(twinsRoot, twin), work, { recursive: true });
    if (existsSync(setup('overlay'))) cpSync(setup('overlay'), work, { recursive: true });
    symlinkSync(modules, join(work, 'node_modules'), 'dir');
    works[twin] = { out, work, log: join(out, 'twin.log') };
  }
  for (let k = 0; k < pairs; k++) {
    const rep = { order: k % 2 ? ['clean', 'planted'] : ['planted', 'clean'] };
    for (const twin of rep.order) {
      const { out, work, log } = works[twin];
      // A step that ITTEN's lock interrupted voids this twin's repeat: it is
      // run again from a fresh database and server once the lock is gone
      // (the wait below, whose limit ends the run with exit 75).
      for (let attempt = 1; ; attempt++) {
      const tables = freshDatabase(scale, join(twinsRoot, twin));
      let app = await serve(work, scale, log);
      const steps = [];
      try {
        for (const step of spec.steps) {
          if (step.restart) { await app.stop(); app = await serve(work, scale, log); }
          const held = await waitForNoLock({ label: `load ${spec.fixture} ${twin} repeat ${k + 1} ${step.id}`, limitMs: lockWait, onWait: (l) => console.error(`load: waiting for ITTEN's timing lock: ${describeLock(l)}`) });
          if (held) { console.error(`load: ITTEN's timing lock is still active; not starting step ${step.id}. ${describeLock(held)}`); process.exit(EXIT_LOCKED); }
          stubFor(step.upstream ?? {});
          const before = environment();
          const result = await runK6(k6, app, step, join(out, `r${k + 1}-${step.id}`), caps);
          const after = await cooled();
          console.log(`load: ${spec.fixture} ${twin} repeat ${k + 1} ${step.id}: ${result.interrupted ? 'interrupted by ITTEN\'s lock' : `${result.counts.requests} requests, ${result.counts.ok} ok, ${result.counts.refused} refused, ${result.counts.failed} failed`}`);
          steps.push({ id: step.id, method: step.method ?? 'GET', path: step.path, route: step.route ?? routeOf(app.routes, step.method ?? 'GET', step.path), rate: step.rate, seconds: step.seconds, ...result, environment: { before, after } });
          if (result.interrupted) break;
        }
      } finally { await app.stop(); }
      if (!steps.some((s) => s.interrupted)) { rep[twin] = { tables, steps }; break; }
      if (attempt >= LOAD_ATTEMPTS) { console.error(`load: ${spec.fixture} ${twin} repeat ${k + 1} was interrupted by ITTEN's lock ${attempt} times; stopping.`); process.exit(EXIT_LOCKED); }
      console.error(`load: ${spec.fixture} ${twin} repeat ${k + 1}: running it again once ITTEN's lock is gone (attempt ${attempt + 1} of ${LOAD_ATTEMPTS})`);
      }
    }
    raw.repeats.push(rep);
  }
  for (const twin of ['planted', 'clean']) rmSync(works[twin].work, { recursive: true, force: true });
  writeFileSync(join(outDir, 'raw.json'), JSON.stringify(raw, null, 2) + '\n');
}

// ---- Headroom (--headroom; the owner, 20 November 2026). For each load
// step, the clean twin's main-thread busy share at the step's rate: the
// step's rate times its request's main-thread time, plus its background's
// rate times the background request's. A clean twin near saturation turns a
// late-share verdict into a coin toss (L09's export, CI run 44682458078), so
// every load form must leave its clean twin at HEADROOM_MAX or less
// (scripts/headroom/judge.js). Main-thread time per request: the twin's
// event-loop utilisation (busy time) over HEADROOM_N requests sent one at a
// time, after HEADROOM_WARM, against a fresh database. No load: one request
// at a time.
async function headroomMain() {
  const HEADROOM_N = 10;
  const HEADROOM_WARM = 3;
  const scale = spec.scale ?? 1;
  const out = join(outDir, 'clean');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const work = join(out, 'work');
  cpSync(join(twinsRoot, 'clean'), work, { recursive: true });
  if (existsSync(setup('overlay'))) cpSync(setup('overlay'), work, { recursive: true });
  symlinkSync(modules, join(work, 'node_modules'), 'dir');
  freshDatabase(scale, join(twinsRoot, 'clean'));
  const app = await serve(work, scale, join(out, 'twin.log'));
  let i = 1_000_000;
  const cost = async (q, upstream) => {
    stubFor(upstream ?? {});
    const one = async () => {
      const n = String(++i);
      const path = String(q.path).replaceAll('%24i', n).replaceAll('$i', n);
      const body = q.body === undefined ? undefined : JSON.parse(JSON.stringify(q.body).replaceAll('$i', n));
      try { await send(app.port, (q.method ?? 'GET').toUpperCase(), path, body, Math.min(q.timeoutMs ?? 10_000, 5_000)); } catch (e) { if (e.code !== 'ERLANG_TIMEOUT') throw e; }
    };
    for (let k = 0; k < HEADROOM_WARM; k++) await one();
    await app.probe('elu-reset');
    for (let k = 0; k < HEADROOM_N; k++) await one();
    const u = await app.probe('elu');
    return u.activeMs / HEADROOM_N;
  };
  const rows = [];
  try {
    for (const step of spec.steps) {
      const ms = await cost(step, step.upstream);
      const bg = step.background ? { method: step.background.method ?? 'GET', path: step.background.path, rate: step.background.rate, ms: await cost(step.background, step.upstream) } : null;
      const busy = (step.rate * ms + (bg ? bg.rate * bg.ms : 0)) / 1000;
      rows.push({ step: step.id, method: step.method ?? 'GET', path: step.path, rate: step.rate, ms: Number(ms.toFixed(3)), background: bg && { ...bg, ms: Number(bg.ms.toFixed(3)) }, busy: Number(busy.toFixed(4)) });
      console.log(`headroom: ${spec.fixture} ${spec.form} clean ${step.id}: busy ${busy.toFixed(3)}`);
    }
  } finally { await app.stop(); stubFor(); }
  rmSync(work, { recursive: true, force: true });
  writeFileSync(join(outDir, 'headroom.json'), JSON.stringify({ fixture: spec.fixture, form: spec.form, twin: 'clean', n: HEADROOM_N, warm: HEADROOM_WARM, environment: environment(), rows }, null, 2) + '\n');
}

// The load average after a step: once below half the CPU count, rereading
// every 5 s for up to 120 s.
async function cooled() {
  const t0 = Date.now();
  for (;;) {
    const e = environment();
    const waited = Math.round((Date.now() - t0) / 1000);
    if (e.load1 < e.cpus / 2) return { ...e, cooledAfterS: waited };
    if (waited >= 120) return { ...e, cooledAfterS: null };
    await sleep(5000);
  }
}

// One step under k6, with the twin's probes sampled every second, and ITTEN's
// lock every 5 s: a lock that appears stops k6 and marks the step interrupted.
async function runK6(k6, app, step, base, caps) {
  checkStep(step, caps);
  const script = `${base}.k6.js`;
  const summary = `${base}.summary.json`;
  // n: the trace form's items at 1x, times the load form's scale.
  const n = (spec.n ?? 1) * (spec.scale ?? 1);
  writeFileSync(script, scenario({ base: `http://127.0.0.1:${app.port}`, step: { ...step, path: expand(step.path, n), ...(step.body === undefined ? {} : { body: expand(step.body, n) }) }, summaryFile: summary, vus: Math.min(caps.maxVUs, step.vus ?? caps.maxVUs) }));
  // Statements (step "measure": ["statements"]): pg_stat_statements over the
  // whole step, for statements per request.
  if (step.measure?.includes('statements')) resetStats();
  // The event loop's longest stretch over the step ("measure": ["loop"], L09).
  if (step.measure?.includes('loop')) await app.probe('loop-reset');
  let heapBefore = null;
  let heapAfter = null;
  // The heap series (L05's heap slope): the heap after a full collection, with the
  // responses answered so far, every heapEvery seconds through the step:
  // at least 5 points with the readings before and after.
  const heapSeries = [];
  const heapEvery = Math.max(1, Math.floor(step.seconds / 8));
  if (step.measure?.includes('memory')) heapBefore = await app.probe('memory');
  const child = spawn(k6, ['run', '--no-usage-report', '--quiet', '--no-color', script], { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, K6_NO_USAGE_REPORT: 'true' } });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((ok) => child.on('exit', (code) => ok(code)));
  let interrupted = false;
  const samples = [];
  const t0 = Date.now();
  const timer = setInterval(async () => {
    const t = Math.round((Date.now() - t0) / 100) / 10;
    const s = { t };
    for (const p of step.probes ?? []) {
      try { s[p] = p === 'connections' ? backends().length : p === 'stub-open' ? stub.open.size : await app.probe(p); } catch (e) { s[p] = { error: e.message }; }
    }
    if (step.probes?.length) samples.push(s);
    if (step.measure?.includes('memory') && Math.round(t) % heapEvery === 0 && Math.round(t) < step.seconds) { try { const h = await app.probe('memory'); heapSeries.push({ t, answered: h.answered, heapUsed: h.heapUsed }); } catch { /* the twin is busy: a point fewer */ } }
    if (Math.round(t) % 5 === 0 && active().length) { interrupted = true; child.kill('SIGINT'); }
  }, 1000);
  const code = await exited;
  clearInterval(timer);
  if (interrupted) return { interrupted: true, counts: {}, samples };
  if (code !== 0 || !existsSync(summary)) throw new Error(`k6 exited ${code} on step ${step.id}: ${stderr.slice(-2000)}`);
  const m = readJson(summary).metrics;
  const count = (name) => m[name]?.values?.count ?? 0;
  const trend = (name) => (m[name] ? { medMs: m[name].values.med, p90Ms: m[name].values['p(90)'], p99Ms: m[name].values['p(99)'], maxMs: m[name].values.max } : null);
  // Heap after a full collection, before and after the step (L05).
  if (step.measure?.includes('memory')) { try { heapAfter = await app.probe('memory'); } catch { heapAfter = null; } }
  // The step's own requests: with a background scenario, http_reqs counts
  // both, so the step's are its four outcomes.
  const own = count('erlang_ok') + count('erlang_late') + count('erlang_refused') + count('erlang_failed');
  const counts = { requests: step.background ? own : count('http_reqs'), ok: count('erlang_ok'), late: count('erlang_late'), refused: count('erlang_refused'), failed: count('erlang_failed'), dropped: count('dropped_iterations'), wireBytes: count('data_received') };
  const statements = step.measure?.includes('statements') ? readStats() : null;
  const loop = step.measure?.includes('loop') ? await app.probe('loop') : null;
  // The calls the stub received during the step, by host (attempts, L06).
  const upstream = stub.hits.length ? Object.entries(stub.hits.reduce((m, h) => ({ ...m, [h.host]: (m[h.host] ?? 0) + 1 }), {})).map(([host, calls]) => ({ host, calls })) : null;
  return { interrupted: false, counts, served: trend('erlang_served_ms'), refusals: trend('erlang_refused_ms'), ...(statements ? { statements: { calls: Object.values(statements).reduce((a, x) => a + x.calls, 0), rows: Object.values(statements).reduce((a, x) => a + x.rows, 0), blocks: Object.values(statements).reduce((a, x) => a + (x.blocks ?? 0), 0), byQuery: statements } } : {}), ...(loop ? { loop: { maxMs: loop.maxMs, meanMs: loop.meanMs } } : {}), ...(upstream ? { upstream } : {}), ...(heapBefore ? { heap: { before: heapBefore.heapUsed, after: heapAfter?.heapUsed ?? null, points: [{ t: 0, answered: heapBefore.answered, heapUsed: heapBefore.heapUsed }, ...heapSeries, ...(heapAfter ? [{ t: step.seconds, answered: heapAfter.answered, heapUsed: heapAfter.heapUsed }] : [])] } } : {}), samples };
}
