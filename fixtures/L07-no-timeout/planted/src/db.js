import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

export const reporting = new pg.Pool({
  connectionString: process.env.REPORTING_URL,
  max: 4,
  statement_timeout: 5000,
  connectionTimeoutMillis: 2000,
});

export function orders(userId) {
  return pool.query('select id, total from orders where user_id = $1 order by id desc limit 50', [userId]);
}
