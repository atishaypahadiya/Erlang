// An in-memory store, standing in for the database.
import crypto from 'node:crypto';

const users = new Map();
const codes = new Map();
// The orders, kept only as their JSON bytes, with their SHA-256 for an
// ETag: made when the orders change, so GET /export neither makes nor
// encodes them per request, and no order is held as an object.
let ordersBytes = Buffer.from('[]');
let ordersEtag = crypto.createHash('sha256').update(ordersBytes).digest('base64url');

export const store = {
  async findUser(email) { return users.get(email) ?? null; },
  async saveUser(user) { users.set(user.email, user); return user; },
  async saveOrders(batch) {
    if (!batch.length) return 0;
    // The batch's JSON, without its brackets, joined to the bytes so far.
    const added = Buffer.from(JSON.stringify(batch).slice(1, -1));
    ordersBytes = Buffer.concat(ordersBytes.length > 2 ? [ordersBytes.subarray(0, -1), Buffer.from(','), added, Buffer.from(']')] : [Buffer.from('['), added, Buffer.from(']')]);
    ordersEtag = crypto.createHash('sha256').update(ordersBytes).digest('base64url');
    return batch.length;
  },
  async ordersExport() { return { bytes: ordersBytes, etag: ordersEtag }; },
  async findCode(email) { return codes.get(email) ?? null; },
  async saveCode(entry) { codes.set(entry.email, entry); return entry; },
};
