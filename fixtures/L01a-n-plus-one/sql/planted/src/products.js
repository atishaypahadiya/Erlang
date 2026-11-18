import { pool } from './db.js';

export async function productById(id) {
  const { rows } = await pool.query('select id, sku, name, price from products where id = $1', [id]);
  return rows[0] ?? null;
}
