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
// Usage: node scripts/trace/run.js <form dir> <out dir> <node_modules dir>
// Environment: ERLANG_TRACE_CONTAINER, ERLANG_TRACE_PORT, ERLANG_TRACE_APP_PASSWORD_FILE.
// Writes <out dir>/<twin>/raw.json and the twin's log.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, symlinkSync, existsSync, openSync, closeSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { expand, routeOf, track, unreadBytes, unreadFields } from '../../lib/trace-judge.js';

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

// The statements the app's role ran since the reset: { query: { calls, rows } }.
function readStats() {
  const json = psql('postgres', DB, `select coalesce(json_object_agg(query, json_build_object('calls', calls, 'rows', rows)), '{}')
from (select s.query, sum(s.calls)::int as calls, sum(s.rows)::int as rows
      from pg_stat_statements s join pg_roles r on r.oid = s.userid join pg_database d on d.oid = s.dbid
      where s.toplevel and r.rolname = '${ROLE}' and d.datname = '${DB}' group by s.query) q;\n`);
  return JSON.parse(json);
}

// One HTTP request to the twin, offering compression, with the bytes as sent.
function send(port, method, path, body) {
  return new Promise((ok, fail) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'accept-encoding': 'gzip, br', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
      res.on('error', fail);
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${path}: no response in 30 s`)));
    req.on('error', fail);
    req.end(data);
  });
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
async function paced() {
  const wait = last + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
}

async function measureRequest(port, routes, r, n) {
  const path = expand(r.path, n);
  const body = r.body === undefined ? undefined : expand(r.body, n);
  const runs = [];
  for (let k = 0; k < 3; k++) {
    await paced();
    resetStats();
    const res = await send(port, r.method, path, body);
    const stats = readStats();
    const decoded = decode(res);
    runs.push({
      status: res.status,
      bytes: res.raw.length,
      encoding: res.headers['content-encoding'] ?? null,
      contentType: res.headers['content-type'] ?? null,
      streamed: res.headers['content-length'] === undefined,
      items: itemsOf(r.items, body, decoded),
      statements: stats,
    });
  }
  const [, a, b] = runs;
  const stable = JSON.stringify({ ...a, bytes: 0 }) === JSON.stringify({ ...b, bytes: 0 });
  return { id: r.id, method: r.method, path, route: routeOf(routes, r.method, path), ...b, stable, ...(stable ? {} : { other: a }) };
}

async function measurePage(port, routes, page, work, n) {
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
  const child = spawn(process.execPath, [join(HERE, 'serve.js'), work, ready], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_URL: `postgres://${ROLE}:${encodeURIComponent(password)}@127.0.0.1:${PORT}/${DB}` },
    stdio: ['ignore', fd, fd],
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
  return { ...info, stop: () => new Promise((ok) => { if (exited !== null) return ok(); child.once('exit', ok); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }) };
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
  symlinkSync(modules, join(work, 'node_modules'), 'dir');
  const log = join(out, 'twin.log');
  const raw = { image: process.env.ERLANG_TRACE_IMAGE ?? null, started: new Date().toISOString(), fixture: spec.fixture, form: spec.form, twin, seed: { schema: Object.fromEntries(schemaFiles(join(formDir, twin)).map((f) => [f.slice(formDir.length + 1), sha256(f)])), seed: sha256(join(formDir, 'trace', 'seed.sql')) }, scales: {} };
  for (const scale of spec.scales) {
    const n = spec.n * scale;
    const tables = freshDatabase(scale, join(formDir, twin));
    const app = await serve(work, scale, log);
    try {
      const requests = [];
      for (const r of spec.requests ?? []) requests.push(await measureRequest(app.port, app.routes, r, n));
      const pages = [];
      for (const p of spec.pages ?? []) pages.push(await measurePage(app.port, app.routes, p, work, n));
      raw.scales[scale] = { n, tables, requests, pages };
    } finally {
      await app.stop();
    }
    console.log(`trace: ${spec.fixture} ${spec.form} ${twin} at ${scale}x: ${(spec.requests ?? []).length} request(s), ${(spec.pages ?? []).length} page view(s)`);
  }
  rmSync(work, { recursive: true, force: true });
  writeFileSync(join(out, 'raw.json'), JSON.stringify(raw, null, 2) + '\n');
}
