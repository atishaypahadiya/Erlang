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

// The counts badge: one call per kind, from a fixed list of two.
export async function counts(api) {
  const out = {};
  for (const kind of ['new', 'sale']) out[kind] = (await api.get(`/products/count?kind=${kind}`)).n;
  return out;
}

// Every product's name, a page at a time: one call per page, not per product.
export async function allNames(api) {
  const names = [];
  let after = 0;
  while (after !== null) {
    const page = await api.get(`/products?after=${after}`);
    names.push(...page.map((p) => p.name));
    after = page.length ? page.at(-1).id : null;
  }
  return names;
}
