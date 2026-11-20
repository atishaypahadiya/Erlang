import { Router } from 'express';
import zlib from 'node:zlib';
import { store } from '../store.js';

export const exports = Router();

// GET /export: every order, compressed, with an ETag. The JSON's bytes and
// their ETag are made when the orders change (store.saveOrders), not per request.
// Only the compression is per request.
exports.get('/export', async function exportOrders(req, res) {
  const { bytes, etag } = await store.ordersExport();
  const body = zlib.gzipSync(bytes);
  res.set({ 'content-encoding': 'gzip', etag: `"${etag}"` }).type('json').send(body);
});
