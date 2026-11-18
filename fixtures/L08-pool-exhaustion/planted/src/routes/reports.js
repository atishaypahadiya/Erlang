import { pool } from '../db.js';

export default async function reports(app) {
  // GET /reports/daily: today's totals and refunds, read from one snapshot.
  app.get('/reports/daily', async function dailyReport() {
    const client = await pool.connect();
    await client.query('begin isolation level repeatable read read only');
    const { rows: totals } = await client.query('select status, count(*)::int as n, sum(total)::int as total from orders where created_at >= current_date group by status');
    const { rows: refunds } = await client.query('select count(*)::int as n from refunds where created_at >= current_date');
    await client.query('commit');
    client.release();
    return { totals, refunds: refunds[0].n };
  });

  // GET /reports/count: how many orders there are, the release chained on the query.
  app.get('/reports/count', async function orderCount() {
    const client = await pool.connect();
    return client.query('select count(*)::int as n from orders').then((r) => r.rows[0]).finally(() => client.release());
  });
}
