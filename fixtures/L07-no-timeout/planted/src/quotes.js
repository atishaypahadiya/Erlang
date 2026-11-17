// Quotes from the pricing service.
const BASE = process.env.PRICING_URL;

export async function getQuote(id) {
  const res = await fetch(`${BASE}/quotes/${id}`);
  return res.json();
}

export async function getQuoteHistory(id) {
  const res = await fetch(`${BASE}/quotes/${id}/history`, { signal: AbortSignal.timeout(3000) });
  return res.json();
}
