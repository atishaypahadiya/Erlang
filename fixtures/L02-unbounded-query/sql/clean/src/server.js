import Fastify from 'fastify';
import reads from './routes/reads.js';

export const app = Fastify({ logger: true });
app.register(reads);
