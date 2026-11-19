import { Router } from 'express';
import crypto from 'node:crypto';
// No bcryptjs: it is pure JavaScript, so even its asynchronous form hashes on the request thread.
import { store } from '../store.js';

export const accounts = Router();

// POST /signup: a new account, its password stretched with PBKDF2.
accounts.post('/signup', async function signup(req, res) {
  const salt = crypto.randomBytes(16);
  const hash = (await new Promise((resolve, reject) => crypto.pbkdf2(req.body.password, salt, 600_000, 64, 'sha512', (err, result) => (err ? reject(err) : resolve(result)))));
  await store.saveUser({ email: req.body.email, salt: salt.toString('hex'), hash: hash.toString('hex') });
  res.status(201).json({ id: crypto.randomUUID() });
});

// POST /login: accounts moved off bcrypt keep a scrypt hash, checked on the worker pool.
accounts.post('/login', async function login(req, res) {
  const user = await store.findUser(req.body.email);
  const ok = !!user?.scryptHash && crypto.timingSafeEqual(Buffer.from(user.scryptHash, 'hex'), await new Promise((resolve, reject) => crypto.scrypt(req.body.password, Buffer.from(user.scryptSalt, 'hex'), 64, (err, key) => (err ? reject(err) : resolve(key)))));
  res.status(ok ? 204 : 401).end();
});

// PUT /password: a new password, hashed with scrypt on the worker pool.
accounts.put('/password', async function changePassword(req, res) {
  const scryptSalt = crypto.randomBytes(16).toString('hex'), scryptHash = (await new Promise((resolve, reject) => crypto.scrypt(req.body.password, Buffer.from(scryptSalt, 'hex'), 64, (err, key) => (err ? reject(err) : resolve(key))))).toString('hex');
  await store.saveUser({ ...(await store.findUser(req.body.email)), scryptSalt, scryptHash });
  res.status(204).end();
});
