import { Router } from 'express';
import { pool } from '../db.js';

export const orders = Router();

// GET /orders/:id: one order and its total.
orders.get('/orders/:id', async function order(req, res) {
  const { rows } = await pool.query('select id, total_cents, created_at from orders where id = $1', [req.params.id]);
  res.status(rows.length ? 200 : 404).json(rows[0] ?? {});
});
