import Fastify from 'fastify';
import routes from './routes.js';

const app = Fastify();
app.register(routes);
await app.listen({ port: 3000 });
