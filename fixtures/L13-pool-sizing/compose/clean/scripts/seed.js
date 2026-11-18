// Fills a development database by hand; no service runs it.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 50 });
await Promise.all(Array.from({ length: 50 }, (_, i) => pool.query('insert into orders (total) values ($1)', [i])));
await pool.end();
