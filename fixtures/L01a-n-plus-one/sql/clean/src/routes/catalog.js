import { productById } from '../products.js';

export default async function catalog(app) {
  // GET /catalog/products/:id: one product.
  app.get('/products/:id', async function product(request) {
    return productById(Number(request.params.id));
  });
}
