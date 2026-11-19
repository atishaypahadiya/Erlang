import express from 'express';
import { orders } from './routes/orders.js';
import { shed } from './shed.js';
export const app = express();
app.use(shed(20)); // At most 20 requests in flight; the rest get 503 at once.
app.use(express.json());
app.use(orders);
app.listen(3000, '127.0.0.1');
