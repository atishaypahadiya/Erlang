// Run by hand to dump the event log: no request waits on it.
import { pool } from '../src/db.js';

const { rows } = await pool.query('select id, kind, created_at from events order by id');
console.log(JSON.stringify(rows));
await pool.end();
