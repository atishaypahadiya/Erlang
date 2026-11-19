import { Router } from 'express';
import { LRUCache } from 'lru-cache';
import { pool } from '../db.js';

export const stats = Router();

// Product counts by category, each kept a minute.
const byCategory = new LRUCache({ max: 200, ttl: 60_000 });

// GET /stats: order totals for the dashboard; they change about once a minute.
stats.get('/stats', async function orderTotals(req, res) {
  const { rows } = await pool.query('select count(*)::int as orders, sum(total_cents)::bigint as revenue from orders');
  res.json(rows[0]);
});

// GET /stats/categories/:id: how many products a category has.
stats.get('/stats/categories/:id', async function categoryCount(req, res) {
  if (!byCategory.has(req.params.id)) byCategory.set(req.params.id, (await pool.query('select count(*)::int as n from products')).rows[0].n);
  res.json({ n: byCategory.get(req.params.id) });
});

// GET /stats/customers/:id: one customer's order count.
stats.get('/stats/customers/:id', async function customerOrders(req, res) {
  res.json((await pool.query('select count(*)::int as n from orders where customer_id = $1', [req.params.id])).rows[0]);
});

// GET /stats/refunds: refund totals, which proxies may keep for five minutes.
stats.get('/stats/refunds', async function refundTotals(req, res) {
  res.set('cache-control', 'public, max-age=300');
  res.json((await pool.query('select count(*)::int as n, sum(amount_cents)::bigint as total from refunds')).rows[0]);
});

// POST /stats/rebuild: recount everything, on the admin's request.
stats.post('/stats/rebuild', async function rebuild(req, res) {
  await pool.query('refresh materialized view order_totals');
  res.json((await pool.query('select count(*)::int as n from order_totals')).rows[0]);
});
