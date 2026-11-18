import { prisma } from '../db.js';
import { recordEvent } from '../audit.js';

// POST /orders/import: orders from an uploaded batch.
export async function importOrders(req, res) {
  await prisma.order.createMany({ data: req.body.rows.map((row) => ({ customerId: row.customerId, total: row.total })) });
  res.status(201).json({ imported: req.body.rows.length });
}

// POST /orders/:id/items: add the items the client sends to an order.
export async function addItems(req, res) {
  const orderId = Number(req.params.id);
  await prisma.lineItem.createMany({ data: req.body.items.map((item) => ({ orderId, productId: item.productId, quantity: item.quantity })) });
  res.status(201).end();
}

// POST /orders/ship: mark the orders the client names as shipped.
export async function shipOrders(req, res) {
  await prisma.order.updateMany({ where: { id: { in: req.body.ids } }, data: { status: 'shipped' } });
  res.status(204).end();
}

// PUT /products/prices: a new price for each product named, a different one each.
export async function setPrices(req, res) {
  await prisma.$executeRaw`update "Product" as p set price = v.price from unnest(${req.body.prices.map((p) => p.id)}::int[], ${req.body.prices.map((p) => p.price)}::int[]) as v(id, price) where p.id = v.id`;
  res.status(204).end();
}

// POST /orders/cancel: cancel the orders named, and record each cancellation.
export async function cancelOrders(req, res) {
  await prisma.order.updateMany({ where: { id: { in: req.body.ids } }, data: { status: 'cancelled' } });
  await prisma.orderEvent.createMany({ data: req.body.ids.map((orderId) => ({ orderId, kind: 'cancelled' })) });
  res.status(204).end();
}

// POST /customers: a new customer, with the two addresses every account starts with.
export async function createCustomer(req, res) {
  const customer = await prisma.customer.create({ data: { email: req.body.email, name: req.body.name } });
  for (const label of ['billing', 'shipping']) await prisma.address.create({ data: { customerId: customer.id, label } });
  res.status(201).json(customer);
}

// DELETE /customers/:id: remove a customer's addresses in one statement.
export async function archiveCustomer(req, res) {
  await prisma.address.deleteMany({ where: { customerId: Number(req.params.id) } });
  res.status(204).end();
}
