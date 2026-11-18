import express from 'express';
import { listOrders, orderItems, lookupOrders, orderCustomers } from './routes/orders.js';
import { listCustomers, customerOrders } from './routes/customers.js';
import { invoices } from './routes/invoices.js';
import { getSettings, someProducts } from './routes/settings.js';

export const app = express();
app.use(express.json());

app.get('/orders', listOrders);
app.get('/orders/:id/items', orderItems);
app.post('/orders/lookup', lookupOrders);
app.get('/orders/customers', orderCustomers);
app.get('/customers', listCustomers);
app.get('/customers/:id/orders', customerOrders);
app.use('/invoices', invoices);
app.get('/settings', getSettings);
app.get('/products', someProducts);
