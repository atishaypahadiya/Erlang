import Fastify from 'fastify';
import orders from './routes/orders.js';
import reports from './routes/reports.js';

export const app = Fastify({ logger: true });
app.register(orders);
app.register(reports);
await app.listen({ port: 3000, host: '0.0.0.0' });
