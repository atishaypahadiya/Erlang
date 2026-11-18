import pg from 'pg';
import { reporting } from '../db.js';

export default async function reports(app) {
  // GET /reports/daily: totals by day, on the reporting pool.
  app.get('/reports/daily', async function daily() {
    return (await reporting().query('select day, total from daily_totals order by day desc limit 31')).rows;
  });

  // GET /reports/export: a page of orders for an export.
  app.get('/reports/export', async function exportPage(request) {
    const pool = reporting();
    return (await pool.query('select id, total from orders where id > $1 order by id limit 500', [request.query.after ?? 0])).rows;
  });
}
