import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { store } from '../store.js';

export const codes = Router();

// One-time sign-in codes last ten minutes and allow five tries, so their hash
// needs little work: cost 4 is 16 rounds, well under a millisecond.
const CODE_COST = 4;

// POST /codes: a six-digit code for an account, kept only as a hash; the
// mailer sends the code itself.
codes.post('/codes', async function issueCode(req, res) {
  const code = String(crypto.randomInt(1_000_000)).padStart(6, '0');
  const codeHash = await bcrypt.hash(code, CODE_COST);
  await store.saveCode({ email: req.body.email, codeHash, expires: Date.now() + 600_000, tries: 0 });
  res.status(202).end();
});

// POST /codes/verify: signs in with the code.
codes.post('/codes/verify', async function verifyCode(req, res) {
  const entry = await store.findCode(req.body.email);
  const ok = !!entry && entry.expires > Date.now() && entry.tries++ < 5 && (await bcrypt.compare(String(req.body.code), entry.codeHash));
  res.status(ok ? 204 : 401).end();
});
