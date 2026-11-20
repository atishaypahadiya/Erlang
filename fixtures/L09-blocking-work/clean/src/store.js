// An in-memory store, standing in for the database.
import crypto from 'node:crypto';

const users = new Map();
const orders = [];
const codes = new Map();
// The orders as JSON bytes, with their SHA-256 for an ETag: made when the
// orders change, so GET /export neither makes nor encodes them per request.
let ordersBytes = Buffer.from('[]');
let ordersEtag = crypto.createHash('sha256').update(ordersBytes).digest('base64url');

export const store = {
  async findUser(email) { return users.get(email) ?? null; },
  async saveUser(user) { users.set(user.email, user); return user; },
  async saveOrders(batch) {
    for (const order of batch) orders.push(order);
    ordersBytes = Buffer.from(JSON.stringify(orders));
    ordersEtag = crypto.createHash('sha256').update(ordersBytes).digest('base64url');
    return batch.length;
  },
  async ordersExport() { return { bytes: ordersBytes, etag: ordersEtag }; },
  async findCode(email) { return codes.get(email) ?? null; },
  async saveCode(entry) { codes.set(entry.email, entry); return entry; },
};
