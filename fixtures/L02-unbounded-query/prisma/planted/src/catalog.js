import { prisma } from './db.js';

export function allProducts() {
  return prisma.product.findMany({ orderBy: { name: 'asc' } });
}
