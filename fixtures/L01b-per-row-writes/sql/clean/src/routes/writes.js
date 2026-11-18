import { pool } from '../db.js';
import { setStock } from '../stock.js';

export default async function writes(app) {
  // POST /api/orders/import: orders from an uploaded batch.
  app.post('/orders/import', async function importOrders(request, reply) {
    await pool.query('insert into orders (customer_id, total) select * from unnest($1::int[], $2::int[])', [request.body.rows.map((r) => r.customerId), request.body.rows.map((r) => r.total)]);
    reply.code(201);
    return { imported: request.body.rows.length };
  });

  // POST /api/orders/:id/items: add items to an order, in one transaction.
  app.post('/orders/:id/items', async function addItems(request, reply) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('insert into line_items (order_id, product_id, quantity) select $1, * from unnest($2::int[], $3::int[])', [request.params.id, request.body.items.map((i) => i.productId), request.body.items.map((i) => i.quantity)]);
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
    await pool.query('update products as p set stock = v.quantity from unnest($1::text[], $2::int[]) as v(sku, quantity) where p.sku = v.sku', [request.body.levels.map((l) => l.sku), request.body.levels.map((l) => l.quantity)]);
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
