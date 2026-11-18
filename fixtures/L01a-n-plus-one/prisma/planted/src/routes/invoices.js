import express from 'express';
import { prisma } from '../db.js';
import { customerName } from '../customers.js';

export const invoices = express.Router();

// GET /invoices: unpaid invoices, each with its customer's name.
invoices.get('/', async function listInvoices(req, res) {
  const unpaid = await prisma.invoice.findMany({ where: { paid: false }, take: 100 });
  for (const invoice of unpaid) invoice.customerName = await customerName(invoice.customerId);
  res.json(unpaid);
});

// GET /invoices/:id: one invoice and its customer's name.
invoices.get('/:id', async function oneInvoice(req, res) {
  const invoice = await prisma.invoice.findUnique({ where: { id: Number(req.params.id) } });
  res.json(invoice && { ...invoice, customerName: await customerName(invoice.customerId) });
});
