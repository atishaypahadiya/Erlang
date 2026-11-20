import { Router } from 'express';
import { Worker } from 'node:worker_threads';
import { store } from '../store.js';

export const exports = Router();

// The compression runs in a worker thread (src/workers/export.js), which
// returns one buffer: the main thread only writes the response. The worker
// is given the orders' bytes when they change, here when the module loads
// and again if their ETag moves, not with every request.
const worker = new Worker(new URL('../workers/export.js', import.meta.url));
worker.unref();
const waiting = new Map();
let next = 0;
let given = null;
worker.on('message', ({ id, body, error }) => {
  const w = waiting.get(id);
  waiting.delete(id);
  if (error) w.reject(new Error(error));
  else w.resolve(Buffer.from(body));
});
worker.on('error', (err) => { for (const w of waiting.values()) w.reject(err); waiting.clear(); });

function giveBytes(bytes, etag) {
  worker.postMessage({ bytes });
  given = etag;
}
const first = await store.ordersExport();
giveBytes(first.bytes, first.etag);

function compressed(bytes, etag) {
  if (etag !== given) giveBytes(bytes, etag);
  return new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id });
  });
}

// GET /export: every order, compressed, with an ETag. The JSON's bytes and
// their ETag are made when the orders change (store.saveOrders), not per
// request; the compression is per request, in the worker.
exports.get('/export', async function exportOrders(req, res) {
  const { bytes, etag } = await store.ordersExport();
  const body = await compressed(bytes, etag);
  res.set({ 'content-encoding': 'gzip', etag: `"${etag}"` }).type('json').send(body);
});
