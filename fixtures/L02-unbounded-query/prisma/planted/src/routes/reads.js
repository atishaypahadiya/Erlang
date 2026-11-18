import { prisma } from '../db.js';

// GET /events: the event log, newest first.
export async function listEvents(req, res) {
  res.json(await prisma.event.findMany({ orderBy: { id: 'desc' } }));
}

// GET /customers: a page of customers, as many as the client asks for.
export async function listCustomers(req, res) {
  res.json(await prisma.customer.findMany({ take: Number(req.query.limit), skip: Number(req.query.offset) || 0, orderBy: { id: 'asc' } }));
}

// GET /orders: a page of orders, at most 200.
export async function listOrders(req, res) {
  res.json(await prisma.order.findMany({ take: Math.min(Number(req.query.limit) || 50, 200), orderBy: { id: 'desc' } }));
}

// GET /stats/revenue: total revenue from paid orders.
export async function revenue(req, res) {
  const paid = await prisma.order.findMany({ where: { status: 'paid' } });
  res.json({ revenue: paid.reduce((sum, o) => sum + o.total, 0) });
}

// GET /orders/:id: one order, by its key.
export async function oneOrder(req, res) {
  res.json(await prisma.order.findMany({ where: { id: Number(req.params.id) } }));
}

// GET /orders/batch?ids=1,2,3: the orders named, at most 50 ids.
export async function ordersByIds(req, res) {
  const ids = String(req.query.ids ?? '').split(',').slice(0, 50).map(Number);
  res.json(await prisma.order.findMany({ where: { id: { in: ids } } }));
}

// GET /customers/by-email: the customer with an email address (unique in the schema).
export async function customerByEmail(req, res) {
  res.json(await prisma.customer.findMany({ where: { email: String(req.query.email) } }));
}

// GET /settings: every setting; a small table named in erlang.config.json.
export async function settings(req, res) {
  res.json(await prisma.setting.findMany());
}

// GET /stats/orders: how many orders there are.
export async function orderCount(req, res) {
  res.json({ orders: await prisma.order.count() });
}
