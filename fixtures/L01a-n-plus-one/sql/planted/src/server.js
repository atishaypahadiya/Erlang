import Fastify from 'fastify';
import orders from './routes/orders.js';
import catalog from './routes/catalog.js';

export const app = Fastify({ logger: true });
app.register(orders);
app.register(catalog, { prefix: '/catalog' });
