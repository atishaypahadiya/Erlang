import express from 'express';
import { listEvents, listCustomers, listOrders, revenue, oneOrder, ordersByIds, customerByEmail, settings, orderCount } from './routes/reads.js';
import { products, topCustomers } from './routes/catalog.js';

// Prisma returns BigInt for BigInt columns and for sum() in raw queries,
// and JSON has no BigInt: send them as strings.
BigInt.prototype.toJSON = function toJSON() { return this.toString(); };

export const app = express();

app.get('/events', listEvents);
app.get('/customers', listCustomers);
app.get('/orders', listOrders);
app.get('/stats/revenue', revenue);
app.get('/orders/batch', ordersByIds);
app.get('/orders/:id', oneOrder);
app.get('/customers/by-email', customerByEmail);
app.get('/settings', settings);
app.get('/stats/orders', orderCount);
app.get('/products', products);
app.get('/reports/top-customers', topCustomers);
