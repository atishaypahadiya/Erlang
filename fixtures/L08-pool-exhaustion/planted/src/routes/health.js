import pg from 'pg';

export default async function health(app) {
  // GET /health/db: a connection of its own, not from the pool, closed after.
  app.get('/health/db', async function dbHealth() {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
    await c.connect();
    try {
      await c.query('select 1');
      return { ok: true };
    } finally {
      await c.end();
    }
  });
}
