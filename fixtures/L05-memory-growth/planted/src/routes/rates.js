import { Router } from 'express';

export const rates = Router();

// Exchange rates by pair, each dropped an hour after it was fetched.
const byPair = new Map();
// Request ids already handled, forgotten in batches of 1,000.
const handled = new Set();
// Per-request data, which goes when the request object does.
const perRequest = new WeakMap();

setInterval(() => {
  for (const [pair, entry] of byPair) if (Date.now() - entry.at > 3_600_000) byPair.delete(pair);
}, 60_000).unref();

// PUT /rates/:pair: a rate a partner sends.
rates.put('/rates/:pair', function putRate(req, res) {
  const id = req.get('idempotency-key') ?? '';
  if (handled.has(id)) return res.status(200).end();
  if (handled.size >= 1000) handled.clear();
  handled.add(id);
  perRequest.set(req, { received: Date.now() });
  byPair.set(req.params.pair, { rate: Number(req.body.rate), at: Date.now() });
  res.status(204).end();
});
