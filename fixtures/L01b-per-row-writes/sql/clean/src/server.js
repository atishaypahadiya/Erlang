import Fastify from 'fastify';
import writes from './routes/writes.js';

export const app = Fastify({ logger: true, bodyLimit: 1048576 });
app.register(writes, { prefix: '/api' });
