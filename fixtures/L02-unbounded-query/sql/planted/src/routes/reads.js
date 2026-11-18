import Cursor from 'pg-cursor';
import { pool } from '../db.js';
import { allProducts } from '../repo.js';

export default async function reads(app) {
  // GET /events: the event log, newest first.
  app.get('/events', async function listEvents(request) {
    return (await pool.query('select id, kind, created_at from events order by id desc')).rows;
  });

  // GET /customers: a page of customers, as many as the client asks for.
  app.get('/customers', async function listCustomers(request) {
    return (await pool.query('select id, name from customers order by id limit $1 offset $2', [request.query.limit, Number(request.query.offset) || 0])).rows;
  });

  // GET /stats/revenue: total revenue from paid orders.
  app.get('/stats/revenue', async function revenue() {
    const { rows } = await pool.query('select total from orders where status = $1', ['paid']);
    return { revenue: rows.reduce((sum, r) => sum + r.total, 0) };
  });

  // GET /products: the catalogue.
  app.get('/products', async function products() {
    return allProducts();
  });

  // GET /orders: a page of orders, at most 200.
  app.get('/orders', async function listOrders(request) {
    return (await pool.query('select id, total from orders order by id desc limit $1', [Math.min(Number(request.query.limit) || 50, 200)])).rows;
  });

  // GET /orders/recent: the 20 latest orders.
  app.get('/orders/recent', async function recentOrders() {
    return (await pool.query('select id, total from orders order by id desc limit 20')).rows;
  });

  // GET /orders/:id: one order, by its key.
  app.get('/orders/:id', async function oneOrder(request) {
    return (await pool.query('select o.id, o.total, c.name from orders o join customers c on c.id = o.customer_id where o.id = $1', [request.params.id])).rows[0] ?? null;
  });

  // GET /orders/batch?ids=1,2,3: the orders named, at most 50 ids.
  app.get('/orders/batch', async function ordersByIds(request) {
    const ids = String(request.query.ids ?? '').split(',').slice(0, 50).map(Number);
    return (await pool.query('select id, total from orders where id = any($1::int[])', [ids])).rows;
  });

  // GET /customers/by-email: the customer with an email address (unique in the migration).
  app.get('/customers/by-email', async function customerByEmail(request) {
    return (await pool.query('select id, name from customers where email = $1', [request.query.email])).rows;
  });

  // GET /products/by-sku/:sku: one product (a unique index on sku).
  app.get('/products/by-sku/:sku', async function productBySku(request) {
    return (await pool.query('select id, sku, name from products where sku = $1', [request.params.sku])).rows;
  });

  // GET /stats/orders: how many orders there are.
  app.get('/stats/orders', async function orderCount() {
    return (await pool.query('select count(*) as orders from orders')).rows[0];
  });

  // GET /settings: every setting; a small table named in erlang.config.json.
  app.get('/settings', async function settings() {
    return (await pool.query('select key, value from settings')).rows;
  });

  // GET /export/events: every event, streamed through a cursor, 500 rows at a time.
  app.get('/export/events', async function exportEvents(request, reply) {
    const client = await pool.connect();
    const cursor = client.query(new Cursor('select id, kind, created_at from events order by id'));
    try {
      for (let rows = await cursor.read(500); rows.length; rows = await cursor.read(500)) reply.raw.write(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } finally {
      await cursor.close();
      client.release();
    }
    reply.raw.end();
  });
}
