import { prisma } from './db.js';

export function recordEvent(orderId, kind) {
  return prisma.orderEvent.create({ data: { orderId, kind } });
}
