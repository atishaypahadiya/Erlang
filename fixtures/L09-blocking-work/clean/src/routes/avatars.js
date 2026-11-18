import { readFile } from 'node:fs/promises';
import { Router } from 'express';
import { join, basename } from 'node:path';
import { PLACEHOLDER } from '../assets.js';

const DIR = process.env.AVATAR_DIR ?? './avatars';
export const avatars = Router();

// GET /avatars/:id: the user's picture, or a placeholder.
avatars.get('/avatars/:id', async function avatar(req, res) {
  let img;
  try {
    img = await readFile(join(DIR, `${basename(req.params.id)}.png`));
  } catch {
    img = PLACEHOLDER;
  }
  res.type('png').send(img);
});
