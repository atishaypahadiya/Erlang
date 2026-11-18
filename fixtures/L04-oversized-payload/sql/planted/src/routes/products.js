import { pool } from '../db.js';

export default async function products(app) {
  // GET /products: the list page's products, 20 at a time.
  app.get('/products', async function listProducts() {
    return (await pool.query('select * from products order by id limit 20')).rows;
  });

  // GET /products/:id/price: one product's price.
  app.get('/products/:id/price', async function productPrice(request) {
    return (await pool.query('select price_cents from products where id = $1', [request.params.id])).rows[0] ?? null;
  });

  // GET /products/:id: one product, for its own page, which shows every field.
  app.get('/products/:id', async function product(request) {
    return (await pool.query('select id, name, price_cents, description from products where id = $1', [request.params.id])).rows[0] ?? null;
  });

  // GET /health: a liveness check, a few bytes.
  app.get('/health', async function health() {
    return { ok: true };
  });
}
