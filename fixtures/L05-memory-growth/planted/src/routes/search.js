import { Router } from 'express';
import { LRUCache } from 'lru-cache';
import { pool } from '../db.js';

export const search = Router();

// Responses already computed, by the request's full URL.
const cache = new Map();
// Suggestions for the search box: at most 500, each kept a minute.
const suggestions = new LRUCache({ max: 500, ttl: 60_000 });

// GET /search?q=...: products whose name matches.
search.get('/search', async function searchProducts(req, res) {
  const hit = cache.get(req.originalUrl);
  if (hit) return res.json(hit);
  const { rows } = await pool.query('select id, name from products where name ilike $1 order by id limit 50', [`%${req.query.q ?? ''}%`]);
  cache.set(req.originalUrl, rows);
  res.json(rows);
});

// GET /suggest?q=...: names that start with q.
search.get('/suggest', async function suggest(req, res) {
  const q = String(req.query.q ?? '').toLowerCase();
  if (!suggestions.has(q)) suggestions.set(q, (await pool.query('select name from products where lower(name) like $1 order by name limit 10', [`${q}%`])).rows.map((r) => r.name));
  res.json(suggestions.get(q));
});
