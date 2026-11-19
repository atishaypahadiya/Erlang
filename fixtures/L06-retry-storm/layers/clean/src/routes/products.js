import { Router } from 'express';
import pRetry, { AbortError } from 'p-retry';
import { stock, reviews } from '../clients.js';
import { fetchPrice } from '../prices.js';
import { budget } from '../budget.js';
export const products = Router();

// GET /products/:id/stock: the stock level, tried up to three times.
products.get('/products/:id/stock', async function stockLevel(req, res) {
  for (let attempt = 1; ; attempt++) {
    try {
      return res.json((await stock.get(`/stock/${req.params.id}`, { 'axios-retry': { retries: 0 } })).data);
    } catch (err) {
      if (attempt >= 3 || err.response?.status < 500 || !budget.spend()) throw err;
      await new Promise((r) => setTimeout(r, Math.random() * Math.min(10_000, 100 * 2 ** attempt)));
    }
  }
});

// GET /products/:id/reviews: the reviews, retried with p-retry.
products.get('/products/:id/reviews', async function productReviews(req, res) {
  res.json(await pRetry(() => reviews.get(`reviews/${req.params.id}`, { retry: { limit: 0 } }).json().catch((e) => { throw e.response?.statusCode < 500 ? new AbortError(e.message) : e; }), { retries: 2, randomize: true, maxTimeout: 10_000, shouldRetry: () => budget.spend() }));
});

// GET /products/:id/price: the price, retried here as well.
products.get('/products/:id/price', async function productPrice(req, res) {
  res.json(await fetchPrice(req.params.id));
});
