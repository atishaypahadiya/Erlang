import express from 'express';
import { importOrders, addItems, shipOrders, setPrices, cancelOrders, createCustomer, archiveCustomer } from './routes/writes.js';

export const app = express();
app.use(express.json({ limit: '1mb' }));

app.post('/orders/import', importOrders);
app.post('/orders/:id/items', addItems);
app.post('/orders/ship', shipOrders);
app.put('/products/prices', setPrices);
app.post('/orders/cancel', cancelOrders);
app.post('/customers', createCustomer);
app.delete('/customers/:id', archiveCustomer);
