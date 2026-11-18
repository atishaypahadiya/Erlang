import { prisma } from '../db.js';

// GET /orders: the latest orders, each with its customer.
export async function listOrders(req, res) {
  const orders = await prisma.order.findMany({ take: 50, orderBy: { id: 'desc' } });
  for (const order of orders) order.customer = await prisma.customer.findUnique({ where: { id: order.customerId } });
  res.json(orders);
}

// GET /orders/:id/items: an order's items, each with its product.
export async function orderItems(req, res) {
  const items = await prisma.lineItem.findMany({ where: { orderId: Number(req.params.id) }, take: 200 });
  const products = await Promise.all(items.map((item) => prisma.product.findFirst({ where: { id: item.productId } })));
  res.json(items.map((item, i) => ({ ...item, product: products[i] })));
}

// POST /orders/lookup: the orders whose ids the client sends.
export async function lookupOrders(req, res) {
  const found = [];
  for (const id of req.body.ids) found.push(await prisma.order.findUnique({ where: { id } }));
  res.json(found.filter(Boolean));
}

// GET /orders/customers: the customers of the latest orders. Prisma 7 sends
// findUnique calls started together as one query.
export async function orderCustomers(req, res) {
  const orders = await prisma.order.findMany({ take: 50, orderBy: { id: 'desc' } });
  res.json(await Promise.all(orders.map((order) => prisma.customer.findUnique({ where: { id: order.customerId } }))));
}
