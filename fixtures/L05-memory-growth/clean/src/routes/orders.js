import { Router } from 'express';
import { pool } from '../db.js';

export const orders = Router();

// The latest orders, for the admin's live view.
const recent = [];
// Currency symbols, fixed when the module loads.
const currencies = new Map([['EUR', '€'], ['USD', '$'], ['GBP', '£']]);
// Request counts, under fixed names.
const counters = new Map();

// POST /orders: a new order.
orders.post('/orders', async function createOrder(req, res) {
  const { rows } = await pool.query('insert into orders (total_cents, currency) values ($1, $2) returning id', [req.body.total, req.body.currency]);
  recent.push({ id: rows[0].id, at: Date.now() });
  if (recent.length > 100) recent.shift();
  counters.set('orders', (counters.get('orders') ?? 0) + 1);
  res.status(201).json({ id: rows[0].id, symbol: currencies.get(req.body.currency) ?? '' });
});

// GET /admin/recent: the last 20 orders seen.
orders.get('/admin/recent', function recentOrders(req, res) {
  res.json(recent.slice(-20));
});

// GET /orders/:id/lines: an order's lines, grouped by product within this request.
orders.get('/orders/:id/lines', async function orderLines(req, res) {
  const byProduct = new Map();
  for (const line of (await pool.query('select product_id, quantity from order_lines where order_id = $1', [req.params.id])).rows) {
    byProduct.set(line.product_id, (byProduct.get(line.product_id) ?? 0) + line.quantity);
  }
  res.json(Object.fromEntries(byProduct));
});
