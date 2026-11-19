import express from 'express';
import { orders } from './routes/orders.js';

export const app = express();
// Every request is accepted, and waits its turn for one of the pool's connections.
app.use(express.json());
app.use(orders);
app.listen(3000, '127.0.0.1');
