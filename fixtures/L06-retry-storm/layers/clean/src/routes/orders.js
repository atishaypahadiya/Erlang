import { Router } from 'express';
import pRetry from 'p-retry';
import { budget } from '../budget.js';
import { fulfilment, search, stock, reviews } from '../clients.js';

export const orders = Router();

// POST /orders: the order, sent to fulfilment under the caller's idempotency key.
orders.post('/orders', async function createOrder(req, res) {
  res.status(201).json(await pRetry(() => fulfilment.post('orders', { json: req.body, headers: { 'idempotency-key': req.get('idempotency-key') ?? '' } }).json(), { retries: 2, randomize: true, maxTimeout: 10_000, shouldRetry: () => budget.spend() }));
});

// GET /search?q=..: results, tried up to three times while the budget lasts.
orders.get('/search', async function searchProducts(req, res) {
  for (let attempt = 1; ; attempt++) {
    try {
      return res.json((await search.get('/search', { params: { q: req.query.q } })).data);
    } catch (err) {
      if (attempt >= 3 || err.response?.status < 500 || !budget.spend()) throw err;
      await new Promise((r) => setTimeout(r, Math.random() * Math.min(10_000, 100 * 2 ** attempt)));
    }
  }
});

// GET /orders/:id/availability: the stock, retried here and not by axios-retry.
orders.get('/orders/:id/availability', async function availability(req, res) {
  res.json(await pRetry(async () => (await stock.get(`/stock/${req.params.id}`, { 'axios-retry': { retries: 0 } })).data, { retries: 2, randomize: true, maxTimeout: 10_000, shouldRetry: () => budget.spend() }));
});

// GET /orders/:id/reviews: the reviews, with got's own retries alone.
orders.get('/orders/:id/reviews', async function orderReviews(req, res) {
  res.json(await reviews.get(`reviews/${req.params.id}`).json());
});
