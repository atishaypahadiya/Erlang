// The L09 trace form's entry: the twin keeps its users and orders in memory
// (src/store.js), so this fills the store, then imports the twin's own
// src/app.js unchanged. Part of the trace form, not of the twins:
// scripts/trace/run.js copies trace/overlay over the twin's copy.
// The overlay also supplies the files the twin reads when it loads, which
// the static pair does not ship: assets/placeholder.png (1x1) and templates/.
//   - one account with both hashes of its password, for POST /login: a
//     bcrypt hash at cost 12, which the planted twin checks, and a scrypt
//     hash, which the clean twin checks;
//   - L09_ORDERS orders (the form's "env": 200,000, about 20 MB of JSON, in
//     the trace form; 1,000,000, about 100 MB, in the load form), for GET
//     /export, saved in one
//     batch (the store makes their JSON bytes and ETag once, when they change).
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { store } from './src/store.js';

const scryptSalt = crypto.randomBytes(16).toString('hex');
const scryptHash = crypto.scryptSync('correct horse', Buffer.from(scryptSalt, 'hex'), 64).toString('hex');
await store.saveUser({ email: 'old@example.test', legacyHash: bcrypt.hashSync('correct horse', 12), scryptSalt, scryptHash });
let orders = [];
const count = Number(process.env.L09_ORDERS);
if (!Number.isInteger(count) || count < 1) throw new Error(`L09_ORDERS must be a whole number of orders, not ${process.env.L09_ORDERS}`);
for (let i = 1; i <= count; i++) {
  orders.push({ id: i, customer: `c${i % 997}`, total: 1000 + (i % 5000), status: ['new', 'paid', 'shipped'][i % 3], items: [{ sku: `sku-${i % 211}`, quantity: 1 + (i % 4) }] });
}
await store.saveOrders(orders);
// The store keeps the orders as JSON bytes only; nothing holds the objects.
orders = null;
export const { app } = await import('./src/app.js');
