import { prisma } from '../db.js';
import { allProducts } from '../catalog.js';

// GET /products: the catalogue.
export async function products(req, res) {
  res.json(await allProducts());
}

// GET /reports/top-customers: customers by what they have spent.
export async function topCustomers(req, res) {
  res.json(await prisma.$queryRaw`select "customerId", sum(total) as spent from "Order" group by "customerId" order by spent desc`);
}
