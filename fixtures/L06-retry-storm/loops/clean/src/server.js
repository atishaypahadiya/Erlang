import Fastify from 'fastify';
import { profile, recommendations, fraudScore, tax, slots, exportResult, orderPages, prices } from './upstream.js';

const app = Fastify();

// GET /home/:id: the home page.
app.get('/home/:id', async function home(request) {
  const id = request.params.id;
  const [user, recs, orders] = await Promise.all([profile(id), recommendations(id), orderPages(id)]);
  return { user, recs, orders };
});

// POST /orders: check and price an order.
app.post('/orders', async function placeOrder(request) {
  const order = request.body;
  const [score, owed, when, latest] = await Promise.all([fraudScore(order), tax(order), slots(order.zip), prices(order.skus)]);
  return { score, owed, when, latest };
});

// GET /exports/:id: an export's result.
app.get('/exports/:id', async function exportById(request) {
  return exportResult(request.params.id);
});

await app.listen({ port: 3000 });
