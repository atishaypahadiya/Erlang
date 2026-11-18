import { prisma } from '../db.js';

// GET /customers: customers, with how many orders each has placed.
export async function listCustomers(req, res) {
  const customers = await prisma.customer.findMany({ take: 50, orderBy: { id: 'asc' }, include: { _count: { select: { orders: true } } } });
  res.json(customers.map(({ _count, ...c }) => ({ ...c, orders: _count.orders })));
}

// GET /customers/:id/orders: one customer's orders with their items, in two queries.
export async function customerOrders(req, res) {
  res.json(await prisma.order.findMany({ where: { customerId: Number(req.params.id) }, take: 50, include: { items: true } }));
}
