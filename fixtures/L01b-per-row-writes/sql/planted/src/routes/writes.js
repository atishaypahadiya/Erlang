import { pool } from '../db.js';
import { setStock } from '../stock.js';

export default async function writes(app) {
  // POST /api/orders/import: orders from an uploaded batch.
  app.post('/orders/import', async function importOrders(request, reply) {
    for (const row of request.body.rows) await pool.query('insert into orders (customer_id, total) values ($1, $2)', [row.customerId, row.total]);
    reply.code(201);
    return { imported: request.body.rows.length };
  });

  // POST /api/orders/:id/items: add items to an order, in one transaction.
  app.post('/orders/:id/items', async function addItems(request, reply) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await Promise.all(request.body.items.map((item) => client.query('insert into line_items (order_id, product_id, quantity) values ($1, $2, $3)', [request.params.id, item.productId, item.quantity])));
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
    reply.code(201);
  });

  // PUT /api/stock: new stock levels for the products named.
  app.put('/stock', async function updateStock(request) {
    for (const level of request.body.levels) await setStock(level.sku, level.quantity);
    return { updated: request.body.levels.length };
  });

  // POST /api/tags: tags for a product, in one multi-row insert.
  app.post('/tags', async function addTags(request) {
    await pool.query('insert into tags (product_id, name) select $1, unnest($2::text[])', [request.body.productId, request.body.tags]);
    return { added: request.body.tags.length };
  });

  // POST /api/teams: a new team, with the two roles every team starts with.
  app.post('/teams', async function createTeam(request) {
    const { rows } = await pool.query('insert into teams (name) values ($1) returning id', [request.body.name]);
    for (const role of ['owner', 'member']) await pool.query('insert into roles (team_id, name) values ($1, $2)', [rows[0].id, role]);
    return rows[0];
  });
}
