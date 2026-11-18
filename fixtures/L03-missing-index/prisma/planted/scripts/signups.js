// Run by hand; no request waits on it.
import { prisma } from '../src/db.js';

console.log(await prisma.event.count({ where: { kind: 'signup' } }));
