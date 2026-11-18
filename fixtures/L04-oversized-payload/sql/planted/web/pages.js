// The pages' data loading, as the browser runs it: api.get(path) resolves to
// the parsed JSON of GET path.

// The product list: each product's name and price.
export async function productList(api) {
  const products = await api.get('/products');
  const rows = [];
  for (const p of products) rows.push({ name: p.name, price: (await api.get(`/products/${p.id}/price`)).price_cents });
  return rows;
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
