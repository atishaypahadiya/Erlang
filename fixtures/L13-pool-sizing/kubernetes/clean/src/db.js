import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = globalThis;

// One client per process, kept across hot reloads in development.
export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 13 }) });
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
