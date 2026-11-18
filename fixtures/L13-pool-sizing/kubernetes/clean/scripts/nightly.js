// Run by the nightly CronJob: one pod at a time, gone when done.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
await pool.query("delete from orders where status = 'cancelled'");
await pool.end();
