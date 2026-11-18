import express from 'express';
import { listEvents, listCustomers, listOrders, revenue, oneOrder, ordersByIds, customerByEmail, settings, orderCount } from './routes/reads.js';
import { products, topCustomers } from './routes/catalog.js';

export const app = express();

app.get('/events', listEvents);
app.get('/customers', listCustomers);
app.get('/orders', listOrders);
app.get('/stats/revenue', revenue);
app.get('/orders/:id', oneOrder);
app.get('/orders/batch', ordersByIds);
app.get('/customers/by-email', customerByEmail);
app.get('/settings', settings);
app.get('/stats/orders', orderCount);
app.get('/products', products);
app.get('/reports/top-customers', topCustomers);
