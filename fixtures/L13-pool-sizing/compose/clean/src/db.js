import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 14, statement_timeout: 5000, connectionTimeoutMillis: 2000 });

let reportingPool = null;

// The reporting pool, made on first use and kept for the life of the process.
export function reporting() {
  reportingPool ??= new pg.Pool({ connectionString: process.env.REPORTING_URL, max: 2, statement_timeout: 30000, connectionTimeoutMillis: 2000 });
  return reportingPool;
}
