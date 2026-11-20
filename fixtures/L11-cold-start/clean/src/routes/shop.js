import { Router } from 'express';
import { pool } from '../db.js';
import { regionOf } from '../regions.js';
import { countryList } from '../countries.js';
import { isHoliday } from '../warm.js';

export const shop = Router();

// The PDF renderer, a large module.
const { render: renderer } = await import('../render/pdf.js');
// Exchange rates, refreshed at most once a minute.
let fx = null;
let units = null; // The currencies a price is shown in, made on first use.
const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }); // Built when the module loads.
// Delivery days, read from the database when the module loads.
const deliveryDays = (await pool.query('select region, days from delivery_days')).rows;

// GET /regions/:postcode: the tax region of a postcode.
shop.get('/regions/:postcode', async function region(req, res) {
  res.json({ region: await regionOf(req.params.postcode), holiday: isHoliday(new Date().toISOString().slice(0, 10)) });
});

// GET /checkout/countries: the countries the shop sends to.
shop.get('/checkout/countries', async function countries(req, res) {
  res.json(await countryList());
});

// GET /invoices/:id.pdf: an invoice as a PDF.
shop.get('/invoices/:id.pdf', async function invoicePdf(req, res) {
  // Built when the module loads, before the app listens.
  const { rows } = await pool.query('select id, total_cents from invoices where id = $1', [req.params.id]);
  res.type('application/pdf').send(renderer(rows[0]));
});

// GET /prices/:id: a price in pounds and euros.
shop.get('/prices/:id', async function price(req, res) {
  if (!fx || Date.now() - fx.at > 60_000) fx = { at: Date.now(), eur: (await pool.query("select rate from fx where pair = 'GBPEUR'")).rows[0].rate };
  if (!units) units = ['GBP', 'EUR'];
  const { rows } = await pool.query('select price_pence from products where id = $1', [req.params.id]);
  res.json({ gbp: money.format(rows[0].price_pence / 100), eur: Math.round(rows[0].price_pence * fx.eur) / 100, units });
});

// POST /orders: an order, with a note from the shop's default when none is given.
shop.post('/orders', async function createOrder(req, res) {
  let note = req.body.note;
  if (!note) note = (await pool.query("select value from settings where name = 'default_note'")).rows[0]?.value ?? '';
  const { rows } = await pool.query('insert into orders (note) values ($1) returning id', [note]);
  res.status(201).json({ id: rows[0].id, days: deliveryDays.length });
});
