import express from 'express';
import { search } from './routes/search.js';
import { orders } from './routes/orders.js';
import { sessions } from './routes/sessions.js';
import { rates } from './routes/rates.js';

export const app = express();
app.use(express.json());
app.use(search);
app.use(orders);
app.use(sessions);
app.use(rates);
app.listen(3000, '127.0.0.1');
