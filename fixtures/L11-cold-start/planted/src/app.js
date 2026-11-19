import express from 'express';
import { shop } from './routes/shop.js';
import { warm } from './warm.js';

export const app = express();
app.use(express.json());
app.use(shop);
await warm();
app.listen(3000, '127.0.0.1');
