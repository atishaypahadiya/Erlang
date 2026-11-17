import { billing, catalog } from './clients.js';

export async function invoice(id: string) {
  const { data } = await billing.get(`/invoices/${id}`);
  return data;
}

export async function product(id: string) {
  const { data } = await catalog.get(`/products/${id}`);
  return data;
}
