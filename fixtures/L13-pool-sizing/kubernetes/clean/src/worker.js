import { prisma } from './db.js';

// Marks paid orders as ready to ship, every few seconds.
setInterval(async () => {
  await prisma.order.updateMany({ where: { status: 'paid' }, data: { status: 'ready' } });
}, 5000);
