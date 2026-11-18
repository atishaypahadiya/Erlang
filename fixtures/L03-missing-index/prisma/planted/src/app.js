import express from 'express';
import { prisma } from './db.js';

const app = express();

// GET /users/:id/events: a user's latest events.
app.get('/users/:id/events', async function userEvents(req, res) {
  res.json(await prisma.event.findMany({ where: { userId: Number(req.params.id) }, orderBy: { createdAt: 'desc' }, take: 50 }));
});

// GET /orders/recent: orders placed since a time.
app.get('/orders/recent', async function recentOrders(req, res) {
  res.json(await prisma.order.findMany({ where: { createdAt: { gte: new Date(String(req.query.since)) } }, orderBy: { createdAt: 'asc' }, take: 100 }));
});

// GET /orders/:id: an order with its items.
app.get('/orders/:id', async function oneOrder(req, res) {
  res.json(await prisma.order.findUnique({ where: { id: Number(req.params.id) }, include: { items: true } }));
});

// GET /users/by-email: a user by email.
app.get('/users/by-email', async function userByEmail(req, res) {
  res.json(await prisma.user.findFirst({ where: { email: String(req.query.email) } }));
});

// GET /users/:id/orders: a user's paid orders.
app.get('/users/:id/orders', async function userOrders(req, res) {
  res.json(await prisma.order.findMany({ where: { userId: Number(req.params.id), status: 'paid' }, take: 50 }));
});

// GET /users/pro: a page of users on the paid plan.
app.get('/users/pro', async function proUsers(req, res) {
  res.json(await prisma.user.findMany({ where: { plan: 'PRO', active: true }, orderBy: { id: 'asc' }, take: 50 }));
});

// GET /countries/:name: a country by name.
app.get('/countries/:name', async function countryByName(req, res) {
  res.json(await prisma.country.findFirst({ where: { name: req.params.name } }));
});

app.listen(3000);
