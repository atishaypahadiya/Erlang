import Fastify from 'fastify';
import compress from '@fastify/compress';
import products from './routes/products.js';

export const app = Fastify({ logger: true });
app.register(compress);
app.register(products);
