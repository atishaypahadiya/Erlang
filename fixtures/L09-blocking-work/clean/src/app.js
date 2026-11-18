import express from 'express';
import { Worker } from 'node:worker_threads';
import { accounts } from './routes/accounts.js';
import { exports } from './routes/exports.js';
import { avatars } from './routes/avatars.js';
import { loadTemplates } from './assets.js';

export const templates = loadTemplates();
export const archiver = new Worker(new URL('./workers/archive.js', import.meta.url));

export const app = express();
app.use(express.json());
app.use(accounts);
app.use(exports);
app.use(avatars);
app.listen(3000);
