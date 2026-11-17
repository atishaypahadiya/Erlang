import { fetchJson, fetchWithDeadline } from './http.js';

const BASE = process.env.INVENTORY_URL;

export function stockLevel(sku) {
  return fetchJson(`${BASE}/stock/${sku}`);
}

export function reservations(sku) {
  return fetchJson(`${BASE}/reservations/${sku}`, { signal: AbortSignal.timeout(2000) });
}

export function warehouses() {
  return fetchWithDeadline(`${BASE}/warehouses`);
}
