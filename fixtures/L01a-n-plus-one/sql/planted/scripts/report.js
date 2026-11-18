// Run by hand at month end: no request waits on it.
import { pool } from '../src/db.js';

const { rows: customers } = await pool.query('select id, name from customers');
for (const c of customers) {
  const { rows } = await pool.query('select sum(total) as spent from orders where customer_id = $1', [c.id]);
  console.log(c.name, rows[0].spent);
}
await pool.end();
