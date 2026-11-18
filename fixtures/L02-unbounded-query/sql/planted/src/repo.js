import { pool } from './db.js';

export async function allProducts() {
  const { rows } = await pool.query('select id, sku, name from products order by name');
  return rows;
}
