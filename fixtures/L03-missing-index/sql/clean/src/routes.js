import { pool } from './db.js';

export default async function routes(app) {
  // GET /users/:id/events: a user's latest events.
  app.get('/users/:id/events', async function userEvents(request) {
    const { rows } = await pool.query('select id, kind, created_at from events where user_id = $1 order by created_at desc limit 50', [request.params.id]);
    return rows;
  });

  // GET /orders/:id/items: the items of one order.
  app.get('/orders/:id/items', async function orderItems(request) {
    const { rows } = await pool.query('select i.sku, i.qty from orders o join order_items i on i.order_id = o.id where o.id = $1', [request.params.id]);
    return rows;
  });

  // GET /orders/recent: orders placed since a time.
  app.get('/orders/recent', async function recentOrders(request) {
    const { rows } = await pool.query('select id, user_id, total_cents from orders where created_at >= $1 order by created_at limit 100', [request.query.since]);
    return rows;
  });

  // GET /users/:id: one user.
  app.get('/users/:id', async function oneUser(request) {
    return (await pool.query('select id, email from users where id = $1', [request.params.id])).rows[0] ?? null;
  });

  // GET /users/by-email: a user by email.
  app.get('/users/by-email', async function userByEmail(request) {
    return (await pool.query('select id from users where email = $1', [request.query.email])).rows[0] ?? null;
  });

  // GET /users/:id/orders: a user's paid orders.
  app.get('/users/:id/orders', async function userOrders(request) {
    return (await pool.query("select id, total_cents from orders where user_id = $1 and status = 'paid' order by id desc limit 50", [request.params.id])).rows;
  });

  // GET /users/active: a page of active users.
  app.get('/users/active', async function activeUsers() {
    return (await pool.query('select id, email from users where active = true order by id limit 50')).rows;
  });

  // GET /countries/:name: a country code by name.
  app.get('/countries/:name', async function countryByName(request) {
    return (await pool.query('select code from countries where name = $1', [request.params.name])).rows[0] ?? null;
  });
}
