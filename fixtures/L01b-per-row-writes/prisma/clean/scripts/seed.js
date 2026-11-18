// Fills a development database: run by hand, no request waits on it.
import { prisma } from '../src/db.js';

for (let i = 1; i <= 1000; i++) {
  await prisma.customer.create({ data: { email: `c${i}@example.test`, name: `Customer ${i}` } });
}
await prisma.$disconnect();
