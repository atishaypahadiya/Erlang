import Fastify from 'fastify';
import products from './routes/products.js';

export const app = Fastify({ logger: true });
// Responses go out as the handlers return them.
app.register(products);
