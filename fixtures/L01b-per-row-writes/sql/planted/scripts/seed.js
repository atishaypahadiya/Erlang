// Fills a development database: run by hand, no request waits on it.
import { pool } from '../src/db.js';

for (let i = 1; i <= 1000; i++) {
  await pool.query('insert into customers (email, name) values ($1, $2)', [`c${i}@example.test`, `Customer ${i}`]);
}
await pool.end();
