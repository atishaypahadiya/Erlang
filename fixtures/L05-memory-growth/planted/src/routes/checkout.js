import { Router } from 'express';
import { pool } from '../db.js';

export const checkout = Router();

// Replies already sent, by the client's idempotency key, with the cart.
const replies = new Map();

// POST /checkout: places the cart once per idempotency key; a retry gets
// the first reply again.
checkout.post('/checkout', async function placeCart(req, res) {
  const key = req.get('idempotency-key') ?? `${req.body.cart?.id}`;
  const seen = replies.get(key);
  if (seen) return res.status(201).json(seen.reply);
  const total = (req.body.cart?.items ?? []).reduce((sum, item) => sum + item.price * item.quantity, 0);
  const { rows } = await pool.query('insert into orders (total_cents, currency) values ($1, $2) returning id', [total, 'EUR']);
  const reply = { id: rows[0].id, total };
  replies.set(key, { cart: req.body.cart, reply });
  res.status(201).json(reply);
});
