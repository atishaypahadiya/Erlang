import Fastify from 'fastify';
import products from './routes/products.js';
import compress from '@fastify/compress';
export const app = Fastify({ logger: true });
app.register(compress);
app.register(products);
