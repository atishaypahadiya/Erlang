import express from 'express';
import { pool } from './db.js';

// The internal API for other services, at most 50 requests in flight.
let waiting = 0;
const internal = express();
internal.use(function limit(req, res, next) {
  if (waiting >= 50) return res.sendStatus(429);
  waiting++;
  res.on('close', () => { waiting--; });
  next();
});
internal.get('/internal/orders/:id/status', async function status(req, res) {
  res.json((await pool.query('select status from orders where id = $1', [req.params.id])).rows[0] ?? {});
});
internal.listen(3002, '127.0.0.1');
