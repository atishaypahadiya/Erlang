// Run by hand: a full export of the products table. No request waits on it.
import { pool } from '../src/db.js';

const { rows } = await pool.query('select * from products order by id');
process.stdout.write(JSON.stringify(rows));
await pool.end();
