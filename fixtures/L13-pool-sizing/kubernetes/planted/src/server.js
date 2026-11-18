import express from 'express';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { prisma } from './db.js';

const app = express();

// GET /orders/:id: one order.
app.get('/orders/:id', async function oneOrder(req, res) {
  res.json(await prisma.order.findUnique({ where: { id: Number(req.params.id) } }));
});

// GET /orders/:id/status: an order's status.
app.get('/orders/:id/status', async function orderStatus(req, res) {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  res.json(await db.order.findUnique({ where: { id: Number(req.params.id) }, select: { status: true } }));
});

app.listen(3000);
