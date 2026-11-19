// The L09 trace form's entry: the twin keeps its users and orders in memory
// (src/store.js), so this fills the store, then imports the twin's own
// src/app.js unchanged. Part of the trace form, not of the twins:
// scripts/trace/run.js copies trace/overlay over the twin's copy.
// The overlay also supplies the files the twin reads when it loads, which
// the static pair does not ship: assets/placeholder.png (1x1) and templates/.
//   - one account from before PBKDF2, with a bcrypt hash at cost 12, for
//     POST /login;
//   - 200,000 orders, about 30 MB of JSON, for GET /export.
import bcrypt from 'bcryptjs';
import { store } from './src/store.js';

await store.saveUser({ email: 'old@example.test', legacyHash: bcrypt.hashSync('correct horse', 12) });
const orders = await store.allOrders();
for (let i = 1; i <= 200_000; i++) {
  orders.push({ id: i, customer: `c${i % 997}`, total: 1000 + (i % 5000), status: ['new', 'paid', 'shipped'][i % 3], items: [{ sku: `sku-${i % 211}`, quantity: 1 + (i % 4) }] });
}
export const { app } = await import('./src/app.js');
