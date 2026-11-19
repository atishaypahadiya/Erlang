import express from 'express';
import { products } from './routes/products.js';
import { orders } from './routes/orders.js';

export const app = express();
app.use(express.json());
app.use(products);
app.use(orders);
app.listen(3000, '127.0.0.1');
