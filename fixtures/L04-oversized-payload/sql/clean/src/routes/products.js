import { pool } from '../db.js';

export default async function products(app) {
  // GET /products: the list page's products, 20 at a time, with the fields it shows.
  app.get('/products', async function listProducts() {
    return (await pool.query('select id, name from products order by id limit 20')).rows;
  });

  // GET /products/prices?ids=1,2,3: the prices of the products named, at most 50.
  app.get('/products/prices', async function productPrices(request) {
    const ids = String(request.query.ids ?? '').split(',').slice(0, 50).map(Number);
    return (await pool.query('select id, price_cents from products where id = any($1::int[])', [ids])).rows;
  });

  // GET /products/:id/price: one product's price.
  app.get('/products/:id/price', async function productPrice(request) {
    return (await pool.query('select price_cents from products where id = $1', [request.params.id])).rows[0] ?? null;
  });

  // GET /products/:id: one product, for its own page, which shows every field.
  app.get('/products/:id', async function product(request) {
    return (await pool.query('select id, name, price_cents, description from products where id = $1', [request.params.id])).rows[0] ?? null;
  });

  // GET /admin/products/:id: one whole row, for the admin's edit form.
  app.get('/admin/products/:id', async function adminProduct(request) {
    return (await pool.query('select * from products where id = $1', [request.params.id])).rows[0] ?? null;
  });

  // GET /products/count: how many products there are.
  app.get('/products/count', async function productCount() {
    return (await pool.query('select count(*)::int as n from products')).rows[0];
  });

  // GET /health: a liveness check, a few bytes.
  app.get('/health', async function health() {
    return { ok: true };
  });
}
