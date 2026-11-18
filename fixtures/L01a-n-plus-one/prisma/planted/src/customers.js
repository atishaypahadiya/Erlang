import { prisma } from './db.js';

export async function customerName(id) {
  const customer = await prisma.customer.findUnique({ where: { id }, select: { name: true } });
  return customer?.name ?? null;
}
