import { pool } from '../db.js';

export default async function imports(app) {
  // POST /imports: rows from an uploaded batch, in one transaction.
  app.post('/imports', async function importRows(request, reply) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('insert into imports (payload) select * from unnest($1::jsonb[])', [request.body.rows]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    }
    client.release();
    reply.code(201);
    return { imported: request.body.rows.length };
  });

  // POST /imports/check: whether a batch would import, released on both paths.
  app.post('/imports/check', async function checkImport(request) {
    const client = await pool.connect();
    try {
      const { rows } = await client.query('select count(*)::int as n from imports where batch_id = $1', [request.body.batchId]);
      client.release();
      return { duplicate: rows[0].n > 0 };
    } catch (e) {
      client.release();
      throw e;
    }
  });
}
