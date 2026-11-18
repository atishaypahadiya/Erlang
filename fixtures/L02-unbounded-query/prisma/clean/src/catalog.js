import { prisma } from './db.js';

export function allProducts() {
  return prisma.product.findMany({ take: 200, orderBy: { name: 'asc' } });
}
