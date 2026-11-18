import { Router } from 'express';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { store } from '../store.js';

export const exports = Router();

// GET /export: every order, compressed, with an ETag.
exports.get('/export', async function exportOrders(req, res) {
  const json = JSON.stringify(await store.allOrders());
  const etag = crypto.createHash('sha256').update(json).digest('base64url');
  const body = (await new Promise((resolve, reject) => zlib.gzip(json, (err, result) => (err ? reject(err) : resolve(result)))));
  res.set({ 'content-encoding': 'gzip', etag: `"${etag}"` }).type('json').send(body);
});
