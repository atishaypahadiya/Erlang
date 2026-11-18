import { pool } from '../db.js';

export default async function orders(app) {
  // GET /orders/:id: one order.
  app.get('/orders/:id', async function oneOrder(request) {
    return (await pool.query('select id, total from orders where id = $1', [request.params.id])).rows[0] ?? null;
  });
}
