// Run by hand once, after a migration: no request waits on it.
import { prisma } from '../src/db.js';

const orders = await prisma.order.findMany();
for (const order of orders) {
  const items = await prisma.lineItem.findMany({ where: { orderId: order.id }, include: { product: true } });
  console.log(order.id, items.reduce((sum, i) => sum + i.quantity * i.product.price, 0));
}
await prisma.$disconnect();
