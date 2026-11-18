import { prisma } from '../db.js';

// GET /settings: three fixed settings rows, one query each.
export async function getSettings(req, res) {
  const settings = {};
  for (const key of ['currency', 'locale', 'timezone']) settings[key] = (await prisma.setting.findUnique({ where: { key } }))?.value;
  res.json(settings);
}

// GET /products?ids=1,2,3: the products named, in one batch transaction.
export async function someProducts(req, res) {
  const ids = String(req.query.ids ?? '').split(',').filter(Boolean).slice(0, 50).map(Number);
  res.json(await prisma.$transaction(ids.map((id) => prisma.product.findUnique({ where: { id } }))));
}
