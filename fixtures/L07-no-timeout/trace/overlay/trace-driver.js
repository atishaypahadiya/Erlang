// The L07 trace form's driver: a server on top of the twin's library, one
// route per function (GET /call/<name>), so the harness can time each call
// while its stub never answers. Part of the trace form, not of the twins:
// scripts/trace/run.js copies trace/overlay over the twin's copy.
// A function that settles answers 200 or 502; one that never settles never
// answers, and the harness records the request as timed out.
import http from 'node:http';
import pg from 'pg';

const cb = (fn) => (...args) => new Promise((ok, fail) => fn(...args, (err, res) => {
  if (err) return fail(err);
  if (res && typeof res.resume === 'function') { res.resume(); res.on('end', () => ok(res.statusCode)); res.on('error', fail); } else ok(res);
}));
const mod = (p) => import(new URL(p, import.meta.url).href);
const LOCK_MS = 9000;

const calls = {
  getQuote: async () => (await mod('./src/quotes.js')).getQuote(1),
  getQuoteHistory: async () => (await mod('./src/quotes.js')).getQuoteHistory(1),
  charge: async () => (await mod('./src/payments.js')).charge({ total: 100, currency: 'EUR' }),
  refund: async () => (await mod('./src/payments.js')).refund({ id: 1 }, { signal: new AbortController().signal }),
  stockLevel: async () => (await mod('./src/inventory.js')).stockLevel('sku-1'),
  reservations: async () => (await mod('./src/inventory.js')).reservations('sku-1'),
  warehouses: async () => (await mod('./src/inventory.js')).warehouses(),
  billing: async () => (await mod('./src/clients.ts')).billing.get('/invoices/1'),
  catalog: async () => (await mod('./src/clients.ts')).catalog.get('/products/1'),
  track: async () => (await mod('./src/shipping.js')).track('T1'),
  label: async () => (await mod('./src/shipping.js')).label({ id: 1 }),
  rate: async () => (await mod('./src/rates.js')).rate('EUR', 'GBP'),
  convert: async () => (await mod('./src/rates.js')).convert(1, 'EUR', 'GBP'),
  lookup: async () => cb((await mod('./src/geo.js')).lookup)('127.0.0.1'),
  region: async () => cb((await mod('./src/geo.js')).region)('127.0.0.1'),
  avatar: async () => cb((await mod('./src/avatars.js')).avatar)(1),
  banner: async () => cb((await mod('./src/avatars.js')).banner)(1),
  badge: async () => cb((await mod('./src/avatars.js')).badge)(1),
  thumbnail: async () => cb((await mod('./src/thumbnails.js')).thumbnail)(1),
  slowReport: async () => (await mod('./src/report.js')).slowReport('http://reports.test/daily'),
  // The pool's query, with orders locked by another session for LOCK_MS:
  // the statement waits until the lock goes or a statement_timeout ends it.
  orders: async () => {
    const locker = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await locker.connect();
    await locker.query('begin');
    await locker.query('lock table orders in access exclusive mode');
    const release = setTimeout(() => locker.query('rollback').finally(() => locker.end()), LOCK_MS);
    try { return (await (await mod('./src/db.js')).orders(1)).rowCount; } finally { clearTimeout(release); await locker.query('rollback').catch(() => {}); await locker.end().catch(() => {}); }
  },
};

process.on('unhandledRejection', () => {});
export const app = http.createServer(async (req, res) => {
  const name = new URL(req.url, 'http://x').pathname.replace(/^\/call\//, '');
  const call = calls[name];
  if (!call) { res.writeHead(404).end(); return; }
  try { await call(); res.writeHead(200).end('{}'); } catch (e) { if (!res.destroyed) res.writeHead(502, { 'content-type': 'text/plain' }).end(String(e?.message ?? e)); }
});
