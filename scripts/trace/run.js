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

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, symlinkSync, existsSync, openSync, closeSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request as httpRequest, createServer } from 'node:http';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { expand, routeOf, track, unreadBytes, unreadFields } from '../../lib/trace-judge.js';
import { environment } from '../../lib/timing.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const [formDir, outDir, modules] = process.argv.slice(2).map((p) => p && resolve(p));
const { ERLANG_TRACE_CONTAINER: CONTAINER, ERLANG_TRACE_PORT: PORT, ERLANG_TRACE_APP_PASSWORD_FILE: PW_FILE } = process.env;
if (!formDir || !outDir || !modules || !CONTAINER || !PORT || !PW_FILE) {
  console.error('usage: node scripts/trace/run.js <form dir> <out dir> <node_modules dir>, with ERLANG_TRACE_CONTAINER, ERLANG_TRACE_PORT and ERLANG_TRACE_APP_PASSWORD_FILE set (scripts/trace.sh sets them)');
  process.exit(64);
}
const DB = 'erlang_trace';
const ROLE = 'erlang_app';
const MIN_GAP_MS = 200; // at most 5 requests a second
const spec = JSON.parse(readFileSync(join(formDir, 'trace', 'trace.json'), 'utf8'));
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ITTEN's timing runs (decision 1): refuse while its inspector is running.
// Temporary, until ITTEN writes its lock file.
function ittenRunning() {
  return spawnSync('pgrep', ['-f', 'inspector/inspect\\.js'], { stdio: 'ignore' }).status === 0;
}

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
const schemaFiles = (twinDir) => spec.schema?.startsWith('twin:')
  ? readdirSync(join(twinDir, spec.schema.slice(5))).filter((f) => f.endsWith('.sql')).sort().map((f) => join(twinDir, spec.schema.slice(5), f))
  : [join(formDir, 'trace', 'schema.sql')];

function freshDatabase(scale, twinDir) {
  psql('postgres', 'postgres', `drop database if exists ${DB} with (force);\ncreate database ${DB} owner ${ROLE};\n`);
  psql('postgres', DB, 'create extension pg_stat_statements;\n');
  for (const f of schemaFiles(twinDir)) psql(ROLE, DB, readFileSync(f, 'utf8'));
  psql(ROLE, DB, readFileSync(join(formDir, 'trace', 'seed.sql'), 'utf8'), { scale });
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
  const json = psql('postgres', DB, `select coalesce(json_object_agg(query, json_build_object('calls', calls, 'rows', rows${spec.params ? ", 'blocks', blocks" : ''})), '{}')
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
  const hits = stub.hits.map((h) => ({ ...h, at: Number((h.at - stub.hits[0].at).toFixed(3)) }));
  const extra = {
    ...(r.upstream || hits.length ? { upstream: hits } : {}),
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
  // for requests that wait out a timeout; more for timings (the lock needs
  // three after the warm-up).
  const count = r.runs ?? spec.runs ?? 3;
  for (let k = 0; k < count; k++) {
    await paced();
    resetStats();
    const { res, timedOut, extra } = await once(app, r, path, body);
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
  const keep = (x) => ({ timedOut: x.timedOut, ...(x.upstream ? { upstream: x.upstream } : {}), ...(x.poolAfter ? { poolBefore: x.poolBefore, poolAfter: x.poolAfter } : {}), ms: x.ms, ...(x.loop ? { loop: x.loop } : {}), ...(x.connections ? { connections: x.connections } : {}), ...(x.logged ? { logged: x.logged, cacheHeaders: x.cacheHeaders, statements: x.statements } : {}), ...(x.plans ? { plans: x.plans } : {}) });
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

for (const twin of ['planted', 'clean']) {
  if (ittenRunning()) {
    console.error('trace: ITTEN\'s inspector is running; refusing to start the next twin (research/trace-harness.md, decision 1)');
    process.exit(75);
  }
  const out = join(outDir, twin);
  const work = join(out, 'work');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(formDir, twin), work, { recursive: true });
  // Trace-only files (a driver for a library with no server) go over the twin.
  if (existsSync(join(formDir, 'trace', 'overlay'))) cpSync(join(formDir, 'trace', 'overlay'), work, { recursive: true });
  symlinkSync(modules, join(work, 'node_modules'), 'dir');
  const log = join(out, 'twin.log');
  const raw = { image: process.env.ERLANG_TRACE_IMAGE ?? null, started: new Date().toISOString(), environment: { before: environment() }, fixture: spec.fixture, form: spec.form, twin, seed: { schema: Object.fromEntries(schemaFiles(join(formDir, twin)).map((f) => [f.slice(formDir.length + 1), sha256(f)])), seed: sha256(join(formDir, 'trace', 'seed.sql')) }, scales: {} };
  for (const scale of spec.scales) {
    const n = spec.n * scale;
    const tables = freshDatabase(scale, join(formDir, twin));
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
      const starts = [];
      for (const r of spec.starts) {
        const samples = [];
        for (let k = 0; k < (r.samples ?? 3); k++) {
          const fresh = await serve(work, scale, log);
          try {
            const runs = [];
            for (let j = 0; j < (r.after ?? 5) + 1; j++) { await paced(); const { res, extra } = await once(fresh, r, expand(r.path, n), r.body === undefined ? undefined : expand(r.body, n)); if (!res || res.status >= 400) throw new Error(`start ${r.id}: ${r.method} answered ${res?.status ?? 'nothing'}`); runs.push({ ms: extra.ms }); }
            samples.push({ firstMs: runs[0].ms, laterMs: runs.slice(1).map((x) => x.ms) });
          } finally { await fresh.stop(); }
        }
        starts.push({ id: r.id, method: r.method, path: expand(r.path, n), route: r.route ?? null, samples });
      }
      raw.scales[scale].starts = starts;
    }
    console.log(`trace: ${spec.fixture} ${spec.form} ${twin} at ${scale}x: ${(spec.requests ?? []).length} request(s), ${(spec.pages ?? []).length} page view(s)`);
  }
  rmSync(work, { recursive: true, force: true });
  raw.environment.after = environment();
  writeFileSync(join(out, 'raw.json'), JSON.stringify(raw, null, 2) + '\n');
}
stubFor();
await new Promise((ok) => stubServer.close(ok));
