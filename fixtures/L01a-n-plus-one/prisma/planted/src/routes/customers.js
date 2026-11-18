import { prisma } from '../db.js';

// GET /customers: customers, with how many orders each has placed.
export async function listCustomers(req, res) {
  const customers = await prisma.customer.findMany({ take: 50, orderBy: { id: 'asc' } });
  res.json(await Promise.all(customers.map(async (c) => ({ ...c, orders: await prisma.order.count({ where: { customerId: c.id } }) }))));
}

// GET /customers/:id/orders: one customer's orders with their items, in two queries.
export async function customerOrders(req, res) {
  res.json(await prisma.order.findMany({ where: { customerId: Number(req.params.id) }, take: 50, include: { items: true } }));
}
