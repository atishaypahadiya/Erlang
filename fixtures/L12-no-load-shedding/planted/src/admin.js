import Fastify from 'fastify';
import underPressure from '@fastify/under-pressure';
import { pool } from './db.js';

// The admin API, refusing with 503 when the event loop falls a second behind.
const admin = Fastify();
admin.register(underPressure, { maxEventLoopDelay: 1000 });
admin.get('/admin/orders/count', async function orderCount() {
  return (await pool.query('select count(*)::int as n from orders')).rows[0];
});
admin.listen({ port: 3001, host: '127.0.0.1' });
