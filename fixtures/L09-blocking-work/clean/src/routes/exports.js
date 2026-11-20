import { Router } from 'express';
import zlib from 'node:zlib';
import { store } from '../store.js';

export const exports = Router();

// GET /export: every order, compressed, with an ETag. The JSON and its ETag
// are made when the orders change (store.saveOrders), not per request.
// Only the compression is per request.
exports.get('/export', async function exportOrders(req, res) {
  const { json, etag } = await store.ordersExport();
  const body = (await new Promise((resolve, reject) => zlib.gzip(json, (err, result) => (err ? reject(err) : resolve(result)))));
  res.set({ 'content-encoding': 'gzip', etag: `"${etag}"` }).type('json').send(body);
});
