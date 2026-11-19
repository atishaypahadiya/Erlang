import express from 'express';
import { stats } from './routes/stats.js';
import { orders } from './routes/orders.js';

export const app = express();
app.use(express.json());
app.use(stats);
app.use(orders);
app.listen(3000, '127.0.0.1');
