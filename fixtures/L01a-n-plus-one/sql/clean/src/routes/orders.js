import { pool } from '../db.js';
import { productById } from '../products.js';

export default async function orders(app) {
  // GET /orders: the latest orders, each with its customer.
  app.get('/orders', async function listOrders() {
    const { rows: orders } = await pool.query("select o.id, o.customer_id, o.total, json_build_object('id', c.id, 'name', c.name, 'email', c.email) as customer from orders o join customers c on c.id = o.customer_id order by o.id desc limit 50");
    // Each order's customer comes from the join above.
    return orders;
  });

  // GET /orders/:id/items: an order's items, each with its product.
  app.get('/orders/:id/items', async function orderItems(request) {
    const { rows: items } = await pool.query('select li.id, li.product_id, li.quantity, row_to_json(p) as product from line_items li join products p on p.id = li.product_id where li.order_id = $1 limit 200', [request.params.id]);
    const products = items.map((item) => item.product);
    return items.map((item, i) => ({ ...item, product: products[i] }));
  });

  // POST /orders/lookup: the orders whose ids the client sends.
  app.post('/orders/lookup', async function lookupOrders(request) {
    const client = await pool.connect();
    try {
      const found = [];
      found.push(...(await client.query('select id, customer_id, total from orders where id = any($1::int[])', [request.body.ids])).rows);
      return found;
    } finally {
      client.release();
    }
  });

  // GET /orders/customers: the customers of the latest orders, in two queries.
  app.get('/orders/customers', async function orderCustomers() {
    const { rows: orders } = await pool.query('select customer_id from orders order by id desc limit 50');
    const ids = [];
    for (const order of orders) ids.push(order.customer_id);
    return (await pool.query('select id, name from customers where id = any($1::int[])', [ids])).rows;
  });

  // GET /settings: three fixed settings rows, one query each.
  app.get('/settings', async function getSettings() {
    const settings = {};
    for (const key of ['currency', 'locale', 'timezone']) settings[key] = (await pool.query('select value from settings where key = $1', [key])).rows[0]?.value;
    return settings;
  });

  // GET /stats: two counts, one query each, run together.
  app.get('/stats', async function stats() {
    const [orders, customers] = await Promise.all([pool.query('select count(*) from orders'), pool.query('select count(*) from customers')]);
    return { orders: orders.rows[0].count, customers: customers.rows[0].count };
  });

  // GET /export: every order, a page of 500 at a time (one query per page, not per row).
  app.get('/export', async function exportOrders(request, reply) {
    let last = 0;
    while (true) {
      const { rows } = await pool.query('select id, customer_id, total from orders where id > $1 order by id limit 500', [last]);
      if (!rows.length) break;
      reply.raw.write(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      last = rows.at(-1).id;
    }
    reply.raw.end();
  });
}
