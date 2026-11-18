// Run by hand once a month; no request waits on it.
import { pool } from '../src/db.js';

const { rows } = await pool.query("select actor_id, count(*) from audit_log where action = 'refund' group by actor_id");
console.log(rows);
await pool.end();
