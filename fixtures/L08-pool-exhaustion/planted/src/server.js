import Fastify from 'fastify';
import orders from './routes/orders.js';
import reports from './routes/reports.js';
import imports from './routes/imports.js';
import health from './routes/health.js';

export const app = Fastify({ logger: true });
app.register(orders);
app.register(reports);
app.register(imports);
app.register(health);
