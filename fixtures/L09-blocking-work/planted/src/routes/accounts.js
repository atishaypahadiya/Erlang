import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { store } from '../store.js';

export const accounts = Router();

// POST /signup: a new account, its password stretched with PBKDF2.
accounts.post('/signup', async function signup(req, res) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(req.body.password, salt, 600_000, 64, 'sha512');
  await store.saveUser({ email: req.body.email, salt: salt.toString('hex'), hash: hash.toString('hex') });
  res.status(201).json({ id: crypto.randomUUID() });
});

// POST /login: accounts from before the move to PBKDF2 still have a bcrypt hash.
accounts.post('/login', async function login(req, res) {
  const user = await store.findUser(req.body.email);
  const ok = user?.legacyHash && bcrypt.compareSync(req.body.password, user.legacyHash);
  res.status(ok ? 204 : 401).end();
});

// PUT /password: a new password, hashed with bcrypt's asynchronous form.
accounts.put('/password', async function changePassword(req, res) {
  const legacyHash = await bcrypt.hash(req.body.password, 12);
  await store.saveUser({ ...(await store.findUser(req.body.email)), legacyHash });
  res.status(204).end();
});
