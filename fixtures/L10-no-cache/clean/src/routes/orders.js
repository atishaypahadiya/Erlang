import { Router } from 'express';
import { pool } from '../db.js';

export const orders = Router();

// GET /orders/:id/lines?region=..: an order's lines with the tax on each.
orders.get('/orders/:id/lines', async function orderLines(req, res) {
  const lines = (await pool.query('select product_id, quantity, price_cents from order_lines where order_id = $1', [req.params.id])).rows;
  const out = [];
  const rate = (await pool.query('select rate from tax_rates where region = $1', [req.query.region])).rows[0]?.rate ?? 0;
  for (const line of lines) {
    out.push({ ...line, tax_cents: Math.round(line.price_cents * line.quantity * rate) });
  }
  res.json(out);
});

// GET /checkout/quote?ids=..: the products' prices, in the shop's currency.
orders.get('/checkout/quote', async function quote(req, res) {
  const currency = (await pool.query('select value from settings where name = $1', ['currency'])).rows[0].value;
  const ids = String(req.query.ids ?? '').split(',').slice(0, 50).map(Number);
  const items = (await pool.query('select id, price_cents from products where id = any($1::int[])', [ids])).rows;
  const symbol = currency;
  res.json({ currency, symbol, items });
});

// GET /orders/products?ids=..: each product named, by its id.
orders.get('/orders/products', async function products(req, res) {
  const out = [];
  for (const id of String(req.query.ids ?? '').split(',').slice(0, 20)) out.push((await pool.query('select id, name from products where id = $1', [id])).rows[0]);
  res.json(out);
});

// POST /accounts/:id/credit: add credit, and return the balance before and after.
orders.post('/accounts/:id/credit', async function credit(req, res) {
  const before = (await pool.query('select balance_cents from accounts where id = $1', [req.params.id])).rows[0];
  await pool.query('update accounts set balance_cents = balance_cents + $2 where id = $1', [req.params.id, req.body.cents]);
  const after = (await pool.query('select balance_cents from accounts where id = $1', [req.params.id])).rows[0];
  res.json({ before, after });
});

// GET /exports/:id/ready: whether an export has finished, polled for up to a minute.
orders.get('/exports/:id/ready', async function exportReady(req, res) {
  const until = Date.now() + 60_000;
  while (Date.now() < until && !(await pool.query('select done from exports where id = $1', [req.params.id])).rows[0]?.done) await new Promise((r) => setTimeout(r, 1000));
  res.json({ ready: Date.now() < until });
});
