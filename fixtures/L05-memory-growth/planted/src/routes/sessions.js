import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { LRUCache } from 'lru-cache';

export const sessions = Router();

// Signed-in users, by session token.
const active = {};
// Failed sign-ins per address: at most 10,000 addresses, each kept 15 minutes.
const attempts = new LRUCache({ max: 10_000, ttl: 900_000 });

// POST /login: a session token for the user.
sessions.post('/login', function login(req, res) {
  if ((attempts.get(req.ip) ?? 0) >= 5) return res.status(429).end();
  const token = randomUUID();
  active[token] = { user: req.body.user, at: Date.now() };
  res.json({ token });
});

// GET /me: the user a token belongs to.
sessions.get('/me', function me(req, res) {
  const session = active[req.get('x-token') ?? ''];
  res.status(session ? 200 : 401).json(session ?? {});
});
