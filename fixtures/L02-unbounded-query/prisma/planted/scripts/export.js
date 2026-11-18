// Run by hand to dump the event log: no request waits on it.
import { prisma } from '../src/db.js';

const events = await prisma.event.findMany({ orderBy: { id: 'asc' } });
console.log(JSON.stringify(events, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
await prisma.$disconnect();
