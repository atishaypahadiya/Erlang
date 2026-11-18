// Run by hand to purge old imports: no request waits on it, and the process
// ends with the pool.
import { pool } from '../src/db.js';

const client = await pool.connect();
await client.query("delete from imports where created_at < now() - interval '90 days'");
await pool.end();
