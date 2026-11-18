// The pages' data loading, as the browser runs it: api.get(path) resolves to
// the parsed JSON of GET path.

// The product list: each product's name and price, the prices in one call.
export async function productList(api) {
  const products = await api.get('/products');
  const prices = await api.get(`/products/prices?ids=${products.map((p) => p.id).join(',')}`);
  const price = new Map(prices.map((r) => [r.id, r.price_cents]));
  return products.map((p) => ({ name: p.name, price: price.get(p.id) }));
}

// A product's own page: every field but the id.
export async function productPage(api, id) {
  const p = await api.get(`/products/${id}`);
  return { name: p.name, price: p.price_cents, description: p.description };
}

// The status badge.
export async function status(api) {
  return (await api.get('/health')).ok;
}
