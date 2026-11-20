// An in-memory store, standing in for the database.
import crypto from 'node:crypto';

const users = new Map();
const orders = [];
const codes = new Map();
// The orders as JSON, with the SHA-256 of that JSON for an ETag: made when
// the orders change, so GET /export does not make them per request.
let ordersJson = '[]';
let ordersEtag = crypto.createHash('sha256').update(ordersJson).digest('base64url');

export const store = {
  async findUser(email) { return users.get(email) ?? null; },
  async saveUser(user) { users.set(user.email, user); return user; },
  async saveOrders(batch) {
    for (const order of batch) orders.push(order);
    ordersJson = JSON.stringify(orders);
    ordersEtag = crypto.createHash('sha256').update(ordersJson).digest('base64url');
    return batch.length;
  },
  async ordersExport() { return { json: ordersJson, etag: ordersEtag }; },
  async findCode(email) { return codes.get(email) ?? null; },
  async saveCode(entry) { codes.set(entry.email, entry); return entry; },
};
