import pg from 'pg';

// Ten connections: past ten requests in flight, each waits for one.
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, statement_timeout: 5000, connectionTimeoutMillis: 2000 });
