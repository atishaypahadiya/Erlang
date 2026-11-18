// Unit cases for what the L07 fixture does not cover: other ways of
// importing and configuring each client, the shapes a fix must handle, and
// controls for per-file isolation; and for n-plus-one and per-row-writes,
// the handlers and shapes the L01 fixtures do not cover. Each case writes a
// small subject to dist/unit/<case>/ and scans it with the checks it is
// about (no-timeout unless it says otherwise).
//
// Usage: node scripts/unit-test.js           exit 0 when every case holds

import { writeFileSync, mkdirSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../bin/erlang.js';
import { apply, syntaxErrors } from '../lib/fix.js';
import { describe, Plain } from '../lib/isolate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist', 'unit');
let failed = 0;
const ok = (name, cond, detail = '') => { if (!cond) failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

rmSync(OUT, { recursive: true, force: true });
let n = 0;
function subject(files) {
  const dir = join(OUT, String(++n).padStart(2, '0'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const scanOf = (dir, only = ['no-timeout']) => scan(dir, { only });
const summary = (r) => r.findings.map((f) => `${f.severity} ${f.where.locations[0].file}:${f.where.locations[0].line} ${f.erlang.fix.kind}`).join('; ') || 'none';

// expect: a list of [severity, file, line, fix kind] in report order, or [].
function expectFindings(name, files, expect, only) {
  const r = scanOf(subject(files), only);
  const got = r.findings.map((f) => [f.severity, f.where.locations[0].file, f.where.locations[0].line, f.erlang.fix.kind]);
  ok(name, r.status === 'complete' && JSON.stringify(got) === JSON.stringify(expect), `${r.status}; got ${summary(r)}`);
  return r;
}

// An auto fix must apply, parse, and leave nothing reported.
function expectAutoFixHolds(name, files, only) {
  const dir = subject(files);
  const before = scanOf(dir, only);
  const f = before.findings[0];
  if (!f || f.erlang.fix.kind !== 'auto') { ok(name, false, `no auto fix: ${summary(before)}`); return; }
  const fixed = `${dir}-fixed`;
  cpSync(dir, fixed, { recursive: true });
  apply(fixed, [f.erlang.fix]);
  const file = f.erlang.fix.edits[0].file;
  const text = readFileSync(join(fixed, file), 'utf8');
  const after = scanOf(fixed, only);
  ok(name, !syntaxErrors(file, text).length && after.status === 'complete' && after.findings.length === 0, `${text.trim().split('\n').find((l) => /timeout|signal|Many\(/.test(l))?.trim()}; after: ${summary(after)}`);
}

console.log('Clients and how they are imported');
expectFindings('CommonJS require of axios: axios.get with no timeout is an error', {
  'a.js': "const axios = require('axios');\nmodule.exports = (u) => axios.get(u);\n",
}, [['error', 'a.js', 2, 'auto']]);
expectFindings('A named import of Pool from pg, with no config: an error with an auto fix', {
  'db.js': "import { Pool } from 'pg';\nexport const pool = new Pool();\n",
}, [['error', 'db.js', 2, 'auto']]);
expectFindings('fetch imported from undici is checked like the global', {
  'u.js': "import { fetch } from 'undici';\nexport const f = (u) => fetch(u);\n",
}, [['error', 'u.js', 2, 'auto']]);
expectFindings('A function named fetch imported from the project is not a network call', {
  'my.js': 'export function fetch(k) { return k; }\n',
  'use.js': "import { fetch } from './my.js';\nexport const g = () => fetch('k');\n",
}, []);
expectFindings('fetch(new Request(url, { signal: AbortSignal.timeout(ms) })) is bounded', {
  'r.js': 'export const f = (u) => fetch(new Request(u, { signal: AbortSignal.timeout(1000) }));\n',
}, []);
expectFindings('An options object declared elsewhere in the module, with a signal, is followed', {
  'o.js': 'const opts = { signal: AbortSignal.timeout(1000) };\nexport const f = (u) => fetch(u, opts);\n',
}, []);
expectFindings('An options object changed after it is declared cannot be judged: info', {
  'm.js': 'export function f(u, s) {\n  const opts = {};\n  opts.signal = s;\n  return fetch(u, opts);\n}\n',
}, [['info', 'm.js', 4, 'guided']]);

console.log('\nDefaults and instances');
expectFindings('axios.defaults.timeout set anywhere bounds the default instance', {
  'setup.js': "import axios from 'axios';\naxios.defaults.timeout = 5000;\n",
  'use.js': "import axios from 'axios';\nexport const f = (u) => axios.get(u);\n",
}, []);
expectFindings('instance.defaults.timeout bounds that instance', {
  'c.js': "import axios from 'axios';\nexport const api = axios.create({ baseURL: 'x' });\napi.defaults.timeout = 2000;\nexport const f = () => api.get('/y');\n",
}, []);
expectFindings('An explicit timeout: 0 on axios is no timeout; the fix is guided, not an edit over the owner\'s value', {
  'z.js': "import axios from 'axios';\nexport const f = (u) => axios.get(u, { timeout: 0 });\n",
}, [['error', 'z.js', 2, 'guided']]);
expectFindings('A got instance extended from one with a request timeout is bounded', {
  'g.js': "import got from 'got';\nconst a = got.extend({ timeout: { request: 1000 } });\nconst b = a.extend({ prefixUrl: 'x' });\nexport const f = () => b.get('y');\n",
}, []);
expectFindings('An axios instance no call uses is not reported', {
  'i.js': "import axios from 'axios';\nexport const unused = axios.create({ baseURL: 'x' });\n",
}, []);

console.log('\nnode:http, and fetch inside helpers');
expectFindings('http.request with req.setTimeout on the request is bounded', {
  'h.js': "import http from 'node:http';\nexport function f(u) {\n  const req = http.request(u);\n  req.setTimeout(1000, () => req.destroy());\n  return req;\n}\n",
}, []);
expectFindings('req.setTimeout(ms) with no callback and no handler only emits an event: a warning, auto-fixed', {
  'h.js': "import https from 'node:https';\nexport function f(url) {\n  const req = https.get(url);\n  req.setTimeout(1000);\n  return req;\n}\n",
}, [['warning', 'h.js', 3, 'auto']]);
expectFindings('A timeout option with a named handler function that destroys the request is bounded', {
  'h.js': "import http from 'node:http';\nfunction giveUp() { this.destroy(); }\nexport const f = (url) => http.get(url, { timeout: 500 }).on('timeout', giveUp);\n",
}, []);
expectAutoFixHolds('A timeout option and no handler: a destroying handler is chained on the call', { 'h.js': "import http from 'node:http';\nexport const f = (url) => http.get(url, { timeout: 500 });\n" });
expectFindings('https.get(url) on a parameter named for a URL, with no options: an error', {
  'h.js': "import https from 'node:https';\nexport const f = (targetUrl, cb) => https.get(targetUrl, cb);\n",
}, [['error', 'h.js', 2, 'guided']]);
expectFindings('https.get(x) where x is a parameter that could be options: info, not a guess', {
  'h.js': "import https from 'node:https';\nexport const f = (x, cb) => https.get(x, cb);\n",
}, [['info', 'h.js', 2, 'guided']]);
expectFindings('A helper whose signal is a parameter: judged at each caller; shorthand { signal } is followed', {
  'h.js': 'export function get(u, signal) {\n  return fetch(u, { signal });\n}\n',
  'a.js': "import { get } from './h.js';\nexport const bad = () => get('x');\nexport const good = () => get('y', AbortSignal.timeout(1000));\n",
}, [['error', 'a.js', 2, 'guided']]);
expectFindings('A helper whose signal comes from a parameter, and nothing calls it: info', {
  'h.js': 'export function get(u, options) {\n  return fetch(u, options);\n}\n',
}, [['info', 'h.js', 2, 'guided']]);

console.log('\nFix shapes');
expectAutoFixHolds('fetch(u, {}): the empty options become { signal }', { 'a.js': 'export const f = (u) => fetch(u, {});\n' });
expectAutoFixHolds('fetch(u, { method }) inline: signal added first, same line', { 'a.js': "export const f = (u) => fetch(u, { method: 'GET' });\n" });
expectAutoFixHolds('axios.post(u, data): the config argument is appended', { 'a.js': "import axios from 'axios';\nexport const f = (u, d) => axios.post(u, d);\n" });
expectAutoFixHolds('new Pool({ ... }) over several lines: the settings go on a line of their own', { 'a.js': "import pg from 'pg';\nexport const p = new pg.Pool({\n  max: 2,\n});\n" });
expectAutoFixHolds('axios.create() with no config gets one', { 'a.js': "import axios from 'axios';\nconst api = axios.create();\nexport const f = () => api.get('/x');\n" });
expectFindings('fetch(u,) with a trailing comma: guided, not edited', { 'a.js': 'export const f = (u) => fetch(u,);\n' }, [['error', 'a.js', 1, 'guided']]);
{
  let threw = '';
  try { apply(OUT, [{ kind: 'guided', locations: [{ file: 'a.js', line: 1 }], note: 'x' }]); } catch (e) { threw = e.message; }
  ok('apply refuses a guided fix', /only auto fixes/.test(threw));
  try { threw = ''; apply(OUT, [{ kind: 'auto', edits: [{ file: 'dist/a.js', line: 1, column: 1, length: 0, replace: 'x' }] }]); } catch (e) { threw = e.message; }
  ok('apply refuses an edit to build output', /build output/.test(threw));
}

console.log('\nn-plus-one and per-row-writes: handlers, versions and shapes');
{
  const DB = ['n-plus-one', 'per-row-writes'];
  const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;
  const PRISMA = "import { PrismaClient } from '@prisma/client';\nexport const prisma = new PrismaClient();\n";
  const P7 = JSON.stringify({ dependencies: { '@prisma/client': '7.10.1' } });
  const P8 = JSON.stringify({ dependencies: { '@prisma/client': '8.0.0' } });
  const express = (body) => `import express from 'express';\nimport { prisma } from './db.js';\nconst app = express();\n${body}`;

  const next = "import { prisma } from '../../../../db.js';\nexport async function GET(request, { params }) {\n  const items = await prisma.lineItem.findMany({ where: { orderId: Number(params.id) } });\n  for (const item of items) item.product = await prisma.product.findUnique({ where: { id: item.productId } });\n  return Response.json(items);\n}\n";
  const r1 = expectFindings('Next.js app route: an awaited findUnique per item is an error, with the route from the folders', {
    'db.js': PRISMA, 'package.json': P7, 'app/orders/[id]/items/route.ts': next,
  }, [['error', 'app/orders/[id]/items/route.ts', 4, 'guided']], DB);
  ok('  its endpoint is GET /orders/:id/items', JSON.stringify(r1.findings[0]?.where.endpoints) === JSON.stringify([{ method: 'GET', route: '/orders/:id/items' }]), JSON.stringify(r1.findings[0]?.where.endpoints));

  const server = "import http from 'node:http';\nimport pg from 'pg';\nconst pool = new pg.Pool();\nhttp.createServer(async (req, res) => {\n  const { rows } = await pool.query('select id from orders limit 50');\n  for (const o of rows) await pool.query('select * from items where order_id = $1', [o.id]);\n  res.end();\n}).listen(3000);\n";
  const r2 = expectFindings('node:http request handler: a pg query per row is an error, with no endpoint', { 'server.js': server }, [['error', 'server.js', 6, 'guided']], DB);
  ok('  no endpoint, since node:http has no route', !r2.findings[0]?.where.endpoints);

  const job = "import { prisma } from './db.js';\nexport async function nightly() {\n  const orders = await prisma.order.findMany();\n  for (const o of orders) await prisma.customer.findUnique({ where: { id: o.customerId } });\n}\n";
  const r3 = expectFindings('No handler found anywhere: the finding is info, and says why', { 'db.js': PRISMA, 'package.json': P7, 'jobs.js': job }, [['info', 'jobs.js', 4, 'guided']], DB);
  ok('  it is marked unresolved and names erlang.config.json', r3.findings[0]?.erlang.unresolved === true && /erlang\.config\.json/.test(r3.findings[0]?.message ?? ''));
  const r4 = expectFindings('The same function named as a handler in erlang.config.json: an error, at its method and route', {
    'db.js': PRISMA, 'package.json': P7, 'jobs.js': job,
    'erlang.config.json': JSON.stringify({ handlers: [{ file: 'jobs.js', function: 'nightly', method: 'RUN', route: 'nightly-totals' }] }),
  }, [['error', 'jobs.js', 4, 'guided']], DB);
  ok('  its endpoint is the brief\'s', JSON.stringify(r4.findings[0]?.where.endpoints) === JSON.stringify([{ method: 'RUN', route: 'nightly-totals' }]));
  const r5 = expectFindings('A brief entry that names no function is a note, not an error', {
    'db.js': PRISMA, 'jobs.js': job, 'erlang.config.json': JSON.stringify({ handlers: [{ file: 'jobs.js', function: 'hourly' }] }),
  }, [['info', 'jobs.js', 4, 'guided']], DB);
  ok('  the note names the entry', JSON.stringify(r5.erlang?.checks?.['n-plus-one+per-row-writes']?.notes ?? []).includes('hourly'), JSON.stringify(r5.erlang?.checks?.['n-plus-one+per-row-writes']?.notes));

  const together = express("app.get('/orders', async (req, res) => {\n  const orders = await prisma.order.findMany({ take: 50 });\n  res.json(await Promise.all(orders.map((o) => prisma.customer.findUnique({ where: { id: o.customerId } }))));\n});\n");
  expectFindings('Prisma 7: findUnique per item, started together, is one query and not reported', { 'db.js': PRISMA, 'package.json': P7, 'app.js': together }, [], DB);
  const r6 = expectFindings('Prisma 8 (from package.json): the same code is an error, since 8 drops the batching', { 'db.js': PRISMA, 'package.json': P8, 'app.js': together }, [['error', 'app.js', 6, 'guided']], DB);
  ok('  the message says Prisma 8 does not batch', /Prisma 8\.0\.0 does not batch/.test(r6.findings[0]?.message ?? ''), r6.findings[0]?.message);
  expectFindings('Prisma 8 from package-lock.json wins over a 7 range in package.json', {
    'db.js': PRISMA, 'package.json': P7, 'package-lock.json': JSON.stringify({ packages: { 'node_modules/@prisma/client': { version: '8.0.1' } } }), 'app.js': together,
  }, [['error', 'app.js', 6, 'guided']], DB);
  const awaitFirst = express("app.get('/orders', async (req, res) => {\n  const orders = await prisma.order.findMany({ take: 50 });\n  res.json(await Promise.all(orders.map(async (o) => {\n    const fx = await fetch(`https://fx.internal/${o.currency}`, { signal: AbortSignal.timeout(1000) });\n    return { fx: await fx.json(), customer: await prisma.customer.findUnique({ where: { id: o.customerId } }) };\n  })));\n});\n");
  expectFindings('An unrelated await before findUnique in the callback: info, since the calls may not start together', { 'db.js': PRISMA, 'package.json': P7, 'app.js': awaitFirst }, [['info', 'app.js', 8, 'guided']], DB);

  const counts = express("app.post('/events', async (req, res) => {\n  for (const key of ['a', 'b', 'c']) await prisma.setting.findUnique({ where: { key } });\n  for (let i = 0; i < 1000; i++) await prisma.event.create({ data: { n: i } });\n  res.end();\n});\n");
  const r7 = expectFindings('A fixed list of three is not reported; a loop to 1000 in a handler is', { 'db.js': PRISMA, 'package.json': P7, 'app.js': counts }, [['warning', 'app.js', 6, 'guided']], DB);
  ok('  the list is a fixed count of 1000', r7.findings[0]?.erlang.over === 'fixed count' && /1000 iterations/.test(r7.findings[0]?.message ?? ''));

  const passed = "import Fastify from 'fastify';\nimport pg from 'pg';\nconst pool = new pg.Pool();\nasync function productOf(item) {\n  return (await pool.query('select * from products where id = $1', [item.productId])).rows[0];\n}\nconst app = Fastify();\napp.get('/orders/:id/items', async function items(request) {\n  const { rows } = await pool.query('select * from line_items where order_id = $1', [request.params.id]);\n  return Promise.all(rows.map(productOf));\n});\n";
  const r8 = expectFindings('A helper passed by name to map: reported at the map, with the query in the helper', { 'app.js': passed }, [['error', 'app.js', 10, 'guided']], DB);
  ok('  both places are named', JSON.stringify(r8.findings[0]?.where.locations.map((l) => l.line)) === JSON.stringify([10, 5]));

  const tx = express("app.post('/import', async (req, res) => {\n  await prisma.$transaction(async (tx) => {\n    for (const row of req.body.rows) await tx.order.create({ data: row });\n  });\n  res.end();\n});\n");
  expectFindings('The client an interactive $transaction passes in is Prisma too: create per row, auto', { 'db.js': PRISMA, 'package.json': P7, 'app.js': tx }, [['warning', 'app.js', 6, 'auto']], DB);
  expectAutoFixHolds('  its createMany fix holds', { 'db.js': PRISMA, 'package.json': P7, 'app.js': tx }, DB);
  const nested = express("app.post('/import', async (req, res) => {\n  for (const o of req.body.orders) await prisma.order.create({ data: { total: o.total, items: { create: o.items } } });\n  res.end();\n});\n");
  expectFindings('A create with a nested write is not turned into createMany, which cannot nest: guided', { 'db.js': PRISMA, 'package.json': P7, 'app.js': nested }, [['warning', 'app.js', 5, 'guided']], DB);
  const differ = express("app.put('/prices', async (req, res) => {\n  for (const p of req.body.prices) await prisma.product.update({ where: { id: p.id }, data: { price: p.price } });\n  res.end();\n});\n");
  expectFindings('An update whose data differs per row cannot be one updateMany: guided', { 'db.js': PRISMA, 'package.json': P7, 'app.js': differ }, [['warning', 'app.js', 5, 'guided']], DB);
  const del = express("app.post('/logout-all', async (req, res) => {\n  for (const id of req.body.sessions) await prisma.session.delete({ where: { id } });\n  res.end();\n});\n");
  expectAutoFixHolds('delete per id in a for loop: one deleteMany, and the fix holds', { 'db.js': PRISMA, 'package.json': P7, 'app.js': del }, DB);
  const sqlFor = "import Fastify from 'fastify';\nimport pg from 'pg';\nimport { sqlFor } from './sql.js';\nconst pool = new pg.Pool();\nconst app = Fastify();\napp.post('/counts', async function counts(request) {\n  for (const t of request.body.tables) await pool.query(sqlFor(t));\n});\n";
  expectFindings('A pg statement built at run time: read or write is unknown, so info under n-plus-one', { 'app.js': sqlFor }, [['info', 'app.js', 7, 'guided']], DB);
}

console.log('\nunbounded-query: sinks, caps and statements');
{
  const UQ = ['unbounded-query'];
  const PRISMA = "import { PrismaClient } from '@prisma/client';\nexport const prisma = new PrismaClient();\n";
  const next = "import { prisma } from '../../db.js';\nexport async function GET() {\n  const events = await prisma.event.findMany();\n  return Response.json(events);\n}\n";
  expectFindings('Next.js route returning Response.json(rows) of a findMany with no take: error', { 'db.js': PRISMA, 'app/events/route.ts': next }, [['error', 'app/events/route.ts', 3, 'guided']], UQ);
  const http = "import http from 'node:http';\nimport pg from 'pg';\nconst pool = new pg.Pool();\nhttp.createServer(async (req, res) => {\n  const { rows } = await pool.query('select * from events');\n  res.end(JSON.stringify(rows));\n}).listen(3000);\n";
  expectFindings('node:http: rows written with res.end(JSON.stringify(rows)): error', { 'server.js': http }, [['error', 'server.js', 5, 'guided']], UQ);
  const fastify = (body) => `import Fastify from 'fastify';\nimport pg from 'pg';\nconst pool = new pg.Pool();\nconst app = Fastify();\n${body}`;
  expectFindings('A LIMIT interpolated from the query string with no cap: error, auto', { 'app.js': fastify("app.get('/e', async function e(request) {\n  return (await pool.query(`select * from events limit ${request.query.n}`)).rows;\n});\n") }, [['error', 'app.js', 6, 'auto']], UQ);
  expectAutoFixHolds('  the cap applied to the interpolated value holds', { 'app.js': fastify("app.get('/e', async function e(request) {\n  return (await pool.query(`select * from events limit ${request.query.n}`)).rows;\n});\n") }, UQ);
  expectFindings('A page size through a helper that clamps with a comparison is capped', { 'app.js': fastify("const pageOf = (n) => (Number(n) > 100 ? 100 : Number(n) || 20);\napp.get('/e', async function e(request) {\n  return (await pool.query('select * from events limit $1', [pageOf(request.query.n)])).rows;\n});\n") }, [], UQ);
  expectFindings('A page size behind a conditional cap is capped', { 'app.js': fastify("app.get('/e', async function e(request) {\n  const n = Number(request.query.n);\n  const size = n > 100 ? 100 : n;\n  return (await pool.query('select * from events limit $1', [size])).rows;\n});\n") }, [], UQ);
  expectFindings('FETCH FIRST 20 ROWS ONLY is a limit', { 'app.js': fastify("app.get('/e', async function e() {\n  return (await pool.query('select * from events order by id fetch first 20 rows only')).rows;\n});\n") }, [], UQ);
  expectFindings('json_agg packs every row into one: its rows[0] sent is every row, an error', { 'app.js': fastify("app.get('/e', async function e() {\n  return (await pool.query('select json_agg(e) as all from events e')).rows[0];\n});\n") }, [['error', 'app.js', 6, 'guided']], UQ);
  expectFindings('count(*) with GROUP BY returns a row per group: reported', { 'app.js': fastify("app.get('/e', async function e() {\n  return (await pool.query('select kind, count(*) from events group by kind')).rows;\n});\n") }, [['error', 'app.js', 6, 'guided']], UQ);
  expectFindings('A statement built at run time is not judged', { 'app.js': fastify("import { sqlFor } from './sql.js';\napp.get('/e', async function e(request) {\n  return (await pool.query(sqlFor(request.query.t))).rows;\n});\n") }, [], UQ);
  const express = (body) => `import express from 'express';\nimport { prisma } from './db.js';\nconst app = express();\n${body}`;
  expectFindings('findMany with a range filter on the key is not bounded by it', { 'db.js': PRISMA, 'app.js': express("app.get('/e', async (req, res) => {\n  res.json(await prisma.event.findMany({ where: { id: { gt: Number(req.query.after) } } }));\n});\n") }, [['error', 'app.js', 5, 'guided']], UQ);
  expectFindings('findMany options spread from code ERLANG cannot read are not judged', { 'db.js': PRISMA, 'app.js': express("import { listOptions } from 'shared-config';\napp.get('/e', async (req, res) => {\n  res.json(await prisma.event.findMany({ ...listOptions }));\n});\n") }, [], UQ);
  expectFindings('Rows whose length alone is sent: a warning, not an error', { 'db.js': PRISMA, 'app.js': express("app.get('/e', async (req, res) => {\n  const all = await prisma.event.findMany();\n  res.json({ total: all.length });\n});\n") }, [['warning', 'app.js', 5, 'guided']], UQ);
  const job = "import { prisma } from './db.js';\nexport async function report() {\n  return prisma.event.findMany();\n}\n";
  expectFindings('No handler found: info', { 'db.js': PRISMA, 'jobs.js': job }, [['info', 'jobs.js', 3, 'guided']], UQ);
  expectFindings('A table named in smallTables is not reported', { 'db.js': PRISMA, 'erlang.config.json': JSON.stringify({ smallTables: ['Country'] }), 'app.js': express("app.get('/c', async (req, res) => {\n  res.json(await prisma.country.findMany());\n});\n") }, [], UQ);
}

console.log('\npool-sizing: deployments, limits and lifetimes');
{
  const { parseYaml } = await import('../lib/yaml.js');
  const [doc] = parseYaml('services:\n  api:\n    image: "postgres:16"   # the db\n    command: ["postgres", "-c", "max_connections=300"]\n    environment:\n      URL: postgres://db:5432/x\n');
  ok('YAML: quoted scalars, flow lists, comments, a colon inside a value, the line of each key', doc.services.api.image === 'postgres:16' && doc.services.api.command[2] === 'max_connections=300' && doc.services.api.environment.URL === 'postgres://db:5432/x' && doc.services.api.$lines.command === 4, JSON.stringify(doc));
  const long = `a${' '.repeat(200_000)}b\nkey: ${'x:'.repeat(100_000)}\n`;
  const t0 = Date.now();
  parseYaml(long);
  ok('YAML: a 200 kB line with no key, and one with 100,000 colons, read in linear time', Date.now() - t0 < 500, `${Date.now() - t0} ms`);
}
{
  const PS = ['pool-sizing'];
  const pg = (max) => `import pg from 'pg';\nexport const pool = new pg.Pool(${max === null ? '' : `{ ${max} }`});\n`;
  const server = "import Fastify from 'fastify';\nimport { pool } from './db.js';\nconst app = Fastify();\napp.get('/x', async function x() { return (await pool.query('select 1')).rows; });\napp.listen({ port: 3000 });\n";
  const compose = (api, db = 'image: postgres:16') => `services:\n  api:\n    build: .\n${api}  db:\n    ${db}\n`;
  expectFindings('Compose replicas × pool max within max_connections: nothing', { 'src/db.js': pg('max: 20'), 'src/server.js': server, 'docker-compose.yml': compose('    command: node src/server.js\n    deploy:\n      replicas: 4\n') }, [], PS);
  expectFindings('A pool with no max (pg default 10) past the limit: error, max inserted', { 'src/db.js': pg('connectionString: process.env.DATABASE_URL'), 'src/server.js': server, 'docker-compose.yml': compose('    command: node src/server.js\n    deploy:\n      replicas: 12\n') }, [['error', 'src/db.js', 2, 'auto']], PS);
  expectAutoFixHolds('  max: 8 inserted: 12 × 8 = 96 of 97', { 'src/db.js': pg('connectionString: process.env.DATABASE_URL'), 'src/server.js': server, 'docker-compose.yml': compose('    command: node src/server.js\n    deploy:\n      replicas: 12\n') }, PS);
  expectFindings('Dockerfile CMD npm start, through package.json, to the entry', { 'src/db.js': pg('max: 40'), 'src/server.js': server, 'package.json': JSON.stringify({ scripts: { start: 'node src/server.js' } }), 'Dockerfile': 'FROM node:22\nCOPY . .\nCMD ["npm", "start"]\n', 'docker-compose.yml': compose('    deploy:\n      replicas: 3\n') }, [['error', 'src/db.js', 2, 'auto']], PS);
  expectFindings('PM2 instances max: the count is unknown, but 2 × 60 already passes 97: error, unresolved, guided', { 'src/db.js': pg('max: 60'), 'src/server.js': server, 'ecosystem.config.cjs': "module.exports = { apps: [{ name: 'api', script: 'src/server.js', instances: 'max' }] };\n", 'docker-compose.yml': compose('    command: pm2-runtime ecosystem.config.cjs\n    deploy:\n      replicas: 2\n') }, [['error', 'src/db.js', 2, 'guided']], PS);
  expectFindings('node:cluster in the entry: the count is unknown and the floor fits: info', { 'src/db.js': pg('max: 10'), 'src/server.js': "import cluster from 'node:cluster';\n" + server, 'docker-compose.yml': compose('    command: node src/server.js\n') }, [['info', 'src/db.js', 2, 'guided']], PS);
  expectFindings('A PgBouncer service in front: info, the database limit is not what the pools meet', { 'src/db.js': pg('max: 50'), 'src/server.js': server, 'docker-compose.yml': compose('    command: node src/server.js\n    deploy:\n      replicas: 4\n  bouncer:\n    image: edoburu/pgbouncer:1.23\n') }, [['info', 'src/db.js', 2, 'guided']], PS);
  expectFindings('max_connections raised on the db service: 4 × 50 within 297', { 'src/db.js': pg('max: 50'), 'src/server.js': server, 'docker-compose.yml': compose('    command: node src/server.js\n    deploy:\n      replicas: 4\n', 'image: postgres:16\n    command: ["postgres", "-c", "max_connections=300"]') }, [], PS);
  const k8s = (replicas) => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: ${replicas}\n  template:\n    spec:\n      containers:\n        - name: api\n          image: example.test/api:1\n          command: ["node", "src/server.js"]\n`;
  expectFindings('Kubernetes with no limit in the repository: info', { 'src/db.js': pg('max: 10'), 'src/server.js': server, 'k8s/api.yaml': k8s(3) }, [['info', 'src/db.js', 2, 'guided']], PS);
  expectFindings('  the limit named in erlang.config.json: 3 × 10 within 97, nothing', { 'src/db.js': pg('max: 10'), 'src/server.js': server, 'k8s/api.yaml': k8s(3), 'erlang.config.json': JSON.stringify({ database: { maxConnections: 100 } }) }, [], PS);
  expectFindings('Helm-templated replicas are unknown: info', { 'src/db.js': pg('max: 10'), 'src/server.js': server, 'k8s/api.yaml': k8s('"{{ .Values.replicas }}"'), 'erlang.config.json': JSON.stringify({ database: { maxConnections: 100 } }) }, [['info', 'src/db.js', 2, 'guided']], PS);
  expectFindings('A pool from a max ERLANG cannot read (an env variable): info', { 'src/db.js': pg('max: Number(process.env.PG_MAX)'), 'src/server.js': server, 'docker-compose.yml': compose('    command: node src/server.js\n') }, [['info', 'src/db.js', 2, 'guided']], PS);
  expectFindings('vercel.json: instances unbounded, info', { 'src/db.js': pg('max: 5'), 'src/server.js': server, 'vercel.json': '{}' }, [['info', 'src/db.js', 2, 'guided']], PS);
  expectFindings('No deployment file: nothing to count', { 'src/db.js': pg('max: 500'), 'src/server.js': server }, [], PS);
  const handler = (body) => `import Fastify from 'fastify';\nimport pg from 'pg';\nconst app = Fastify();\nlet cached;\n${body}\napp.listen({ port: 3000 });\n`;
  expectFindings('A pool kept in a module variable on first use (if (!x) x = ...) is not per request', { 'src/server.js': handler("app.get('/x', async function x() {\n  if (!cached) cached = new pg.Pool({ max: 2 });\n  return (await cached.query('select 1')).rows;\n});") }, [], PS);
  expectFindings('A pool kept on globalThis is not per request', { 'src/server.js': handler("app.get('/x', async function x() {\n  const pool = (globalThis.pool ??= new pg.Pool({ max: 2 }));\n  return (await pool.query('select 1')).rows;\n});") }, [], PS);
  expectFindings('A pool returned by a factory each handler calls: per request', { 'src/server.js': handler("function makePool() {\n  return new pg.Pool({ max: 2 });\n}\napp.get('/x', async function x() {\n  return (await makePool().query('select 1')).rows;\n});") }, [['error', 'src/server.js', 6, 'guided']], PS);
  expectFindings('A pg Client per request, ended in finally: still per request', { 'src/server.js': handler("app.get('/x', async function x() {\n  const c = new pg.Client();\n  await c.connect();\n  try { return (await c.query('select 1')).rows; } finally { await c.end(); }\n});") }, [['error', 'src/server.js', 6, 'guided']], PS);
}

console.log('\nIsolation and scope');
{
  const dir = subject({
    'good.js': 'export const f = (u) => fetch(u);\n',
    'bad.js': Buffer.from([0x66, 0x28, 0xc3, 0x28, 0x29, 0x0a]).toString('latin1'),
  });
  writeFileSync(join(dir, 'bad.js'), Buffer.from([0x66, 0x28, 0xc3, 0x28, 0x29, 0x0a]));
  const r = scanOf(dir);
  ok('A file that is not UTF-8 is unread, the report is partial, and other files are still checked', r.status === 'partial' && r.reason.includes('bad.js: not read') && r.findings.length === 1, `${r.status}; ${summary(r)}`);
}
{
  const dir = subject({ 'a.js': 'export const f = (u) => fetch(u);\n' });
  const quoted = 'SECRET_TEXT_FROM_A_FILE';
  const r = scan(dir, { modules: [{ CHECK: 'boom', run() { throw new SyntaxError(`Unexpected token ${quoted} at line 3 column 7`); } }] });
  ok('A check that throws stops itself only; the report is partial and describes the error without quoting it', r.status === 'partial' && r.reason.includes('boom: stopped') && r.reason.includes('line 3, column 7') && !r.reason.includes(quoted), r.reason);
}
ok('describe() gives a Plain error\'s own words, and only the kind and position of any other', describe(new Plain('too large')) === 'too large' && !describe(new Error('value=hunter2 at position 4')).includes('hunter2'));
{
  const dir = subject({ 'erlang.config.json': '{ "exclude": ["tools/"] }\n', 'tools/x.js': 'fetch(u);\n', 'src/y.js': 'export const g = (u) => fetch(u, { signal: AbortSignal.timeout(5) });\n' });
  const r = scanOf(dir);
  ok('erlang.config.json excludes a directory, and the report says so', r.status === 'complete' && r.findings.length === 0 && r.erlang.scope.exclude.includes('tools'), summary(r));
}
{
  const dir = subject({ 'erlang.config.json': '{ "exclude": ["nothing-here/"] }\n', 'a.js': '' });
  const r = scanOf(dir);
  ok('An exclude entry that matches nothing is a note in the report', r.erlang.scope.notes.some((x) => x.includes('nothing-here')));
}
{
  const dir = subject({ 'big.js': `export const s = '${'x'.repeat(1024 * 1024)}';\n` });
  const r = scanOf(dir);
  ok('A file over 1 MiB is not read as source: partial, with the reason in ERLANG\'s own words', r.status === 'partial' && /big\.js: not read, an error stopped it \(larger than \d+ bytes/.test(r.reason), r.reason);
}

console.log(failed ? `\n${failed} unit case(s) failed` : '\nevery unit case holds');
process.exit(failed ? 1 : 0);
