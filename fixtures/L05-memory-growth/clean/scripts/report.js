// Run by hand: the day's orders as lines of text. No request runs it.
import { pool } from '../src/db.js';

const lines = [];
for (const row of (await pool.query('select id, total_cents from orders where created_at >= current_date')).rows) lines.push(`${row.id}\t${row.total_cents}`);
process.stdout.write(lines.join('\n'));
await pool.end();
