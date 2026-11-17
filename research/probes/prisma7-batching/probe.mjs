// Which Prisma 7.10.1 access patterns send one statement and which send one
// per item, observed from Prisma's own query log against SQLite. The n-plus-one
// and per-row-writes checks are built on these results, not on what the docs
// or the source suggest (research/prisma-batching.md).
//
// Ten customers, each with one order. Every case runs on a fresh log and
// records the statements Prisma sent: SELECTs and INSERTs, with transaction
// control (BEGIN, COMMIT) counted apart.
//
// Usage: node probe.mjs <result.json> [js|ts]   (run.sh does this in dist/)

import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// Which generated client: js (prisma-client-js) or ts (prisma-client, its
// TypeScript run with Node's type stripping).
const out = process.argv[2];
const generator = process.argv[3] ?? 'js';
const { PrismaClient } = generator === 'ts' ? await import('./generated-ts/client.ts') : require('./generated/index.js');
const file = new URL(`./probe-${generator}.db`, import.meta.url).pathname;
rmSync(file, { force: true });

// Tables as the schema declares them, made directly, so no migration tool runs.
const db = new Database(file);
db.exec(`
  create table Customer (id integer primary key, email text not null unique, name text not null);
  create table "Order" (id integer primary key autoincrement, customerId integer not null references Customer(id), total integer not null);
`);
const N = 10;
for (let i = 1; i <= N; i++) {
  db.prepare('insert into Customer (id, email, name) values (?, ?, ?)').run(i, `c${i}@example.test`, `Customer ${i}`);
  db.prepare('insert into "Order" (customerId, total) values (?, ?)').run(i, i * 100);
}
db.close();

const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }), log: [{ emit: 'event', level: 'query' }] });
let log = [];
prisma.$on('query', (e) => log.push(e.query));

const ids = Array.from({ length: N }, (_, i) => i + 1);
const kind = (q) => (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(q) ? 'tx' : /^\s*SELECT/i.test(q) ? 'select' : /^\s*INSERT/i.test(q) ? 'insert' : /^\s*(UPDATE|DELETE)/i.test(q) ? 'write' : 'other');
const shape = (q) => q.replace(/\s+/g, ' ').replace(/`main`\./g, '').replace(/\?(, \?)+/g, '?, …').trim();

const cases = [
  ['read: await findUnique by id in a for loop', async () => { for (const id of ids) await prisma.customer.findUnique({ where: { id } }); }],
  ['read: Promise.all of findUnique by id', () => Promise.all(ids.map((id) => prisma.customer.findUnique({ where: { id } })))],
  ['read: Promise.all of findUnique by a @unique field (email)', () => Promise.all(ids.map((id) => prisma.customer.findUnique({ where: { email: `c${id}@example.test` } })))],
  ['read: Promise.all of findUnique by id with the same include', () => Promise.all(ids.map((id) => prisma.customer.findUnique({ where: { id }, include: { orders: true } })))],
  ['read: Promise.all of findUnique by id with different selects', () => Promise.all(ids.map((id) => prisma.customer.findUnique({ where: { id }, select: id % 2 ? { id: true } : { name: true } })))],
  ['read: Promise.all of findUnique by id plus a non-unique filter', () => Promise.all(ids.map((id) => prisma.customer.findUnique({ where: { id, name: `Customer ${id}` } })))],
  ['read: Promise.all of findUniqueOrThrow by id', () => Promise.all(ids.map((id) => prisma.customer.findUniqueOrThrow({ where: { id } })))],
  ['read: Promise.all of findFirst by id', () => Promise.all(ids.map((id) => prisma.customer.findFirst({ where: { id } })))],
  ['read: Promise.all of findMany by id', () => Promise.all(ids.map((id) => prisma.customer.findMany({ where: { id } })))],
  ['read: Promise.all of async callbacks that await findUnique', () => Promise.all(ids.map(async (id) => { const c = await prisma.customer.findUnique({ where: { id } }); return c; }))],
  ['read: Promise.all of async callbacks that await something else first', () => Promise.all(ids.map(async (id) => { await Promise.resolve(); return prisma.customer.findUnique({ where: { id } }); }))],
  ['read: Promise.all of async callbacks that await another query first', () => Promise.all(ids.map(async (id) => { const o = await prisma.order.findUnique({ where: { id } }); return prisma.customer.findUnique({ where: { id: o.customerId } }); }))],
  ['read: findUnique promises collected in a for loop, then Promise.all', async () => { const pending = []; for (const id of ids) pending.push(prisma.customer.findUnique({ where: { id } })); await Promise.all(pending); }],
  ['read: findUnique in a forEach callback, not awaited', async () => { const pending = []; ids.forEach((id) => { pending.push(prisma.customer.findUnique({ where: { id } })); }); await Promise.all(pending); }],
  ['read: count in Promise.all', () => Promise.all(ids.map((id) => prisma.order.count({ where: { customerId: id } })))],
  ['read: Promise.all of the fluent relation order.findUnique().customer()', () => Promise.all(ids.map((id) => prisma.order.findUnique({ where: { id } }).customer()))],
  ['read: per-order customer, after findMany, in a for loop', async () => { const orders = await prisma.order.findMany(); for (const o of orders) await prisma.customer.findUnique({ where: { id: o.customerId } }); }],
  ['read: per-order customer, after findMany, in Promise.all', async () => { const orders = await prisma.order.findMany(); await Promise.all(orders.map((o) => prisma.customer.findUnique({ where: { id: o.customerId } }))); }],
  ['read: findMany with include (eager load)', () => prisma.order.findMany({ include: { customer: true } })],
  ['read: findUnique in Promise.all inside an interactive transaction', () => prisma.$transaction((tx) => Promise.all(ids.map((id) => tx.customer.findUnique({ where: { id } }))))],
  ['read: findUnique calls in a batch $transaction([...])', () => prisma.$transaction(ids.map((id) => prisma.customer.findUnique({ where: { id } })))],
  ['write: await create in a for loop', async () => { for (const id of ids) await prisma.order.create({ data: { customerId: id, total: 1 } }); }],
  ['write: Promise.all of create', () => Promise.all(ids.map((id) => prisma.order.create({ data: { customerId: id, total: 1 } })))],
  ['write: createMany', () => prisma.order.createMany({ data: ids.map((id) => ({ customerId: id, total: 1 })) })],
  ['write: create calls in a batch $transaction([...])', () => prisma.$transaction(ids.map((id) => prisma.order.create({ data: { customerId: id, total: 1 } })))],
  ['write: await update in a for loop', async () => { for (const id of ids) await prisma.order.update({ where: { id }, data: { total: 2 } }); }],
  ['write: updateMany', () => prisma.order.updateMany({ where: { id: { in: ids } }, data: { total: 3 } })],
];

const results = [];
for (const [name, fn] of cases) {
  log = [];
  await fn();
  await new Promise((r) => setTimeout(r, 20));
  const counts = { select: 0, insert: 0, write: 0, tx: 0, other: 0 };
  for (const q of log) counts[kind(q)]++;
  results.push({ case: name, items: N, statements: log.length - counts.tx, ...counts, shapes: [...new Set(log.filter((q) => kind(q) !== 'tx').map(shape))] });
  console.log(`${String(log.length - counts.tx).padStart(3)} statement(s)  ${name}`);
}
await prisma.$disconnect();

const pkg = (name) => JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
writeFileSync(out, JSON.stringify({
  probe: 'prisma7-batching',
  ran: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  node: process.version,
  generator: generator === 'ts' ? 'prisma-client' : 'prisma-client-js',
  versions: { prisma: pkg('prisma'), '@prisma/client': pkg('@prisma/client'), '@prisma/adapter-better-sqlite3': pkg('@prisma/adapter-better-sqlite3'), 'better-sqlite3': pkg('better-sqlite3') },
  database: 'SQLite (better-sqlite3), a file in dist/',
  results,
}, null, 2) + '\n');
console.log(`result: ${out}`);
