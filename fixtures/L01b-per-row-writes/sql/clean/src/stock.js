import { pool } from './db.js';

export function setStock(sku, quantity) {
  return pool.query('update products set stock = $2 where sku = $1', [sku, quantity]);
}
