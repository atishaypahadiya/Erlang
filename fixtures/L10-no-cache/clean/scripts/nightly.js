// Run by cron at night: the day's totals, written to the log. No request runs it.
import { pool } from '../src/db.js';

console.log((await pool.query('select count(*)::int as orders, sum(total_cents)::bigint as revenue from orders')).rows[0]);
await pool.end();
