import express from 'express';
import { payments, inventory, shipping, catalog } from './clients.js';
import { quote, stock, rates } from './pricing.js';

const app = express();
app.use(express.json());

// GET /checkout/:sku: what an order for one item would cost.
app.get('/checkout/:sku', async (req, res) => {
  const sku = req.params.sku;
  const [price, left, balance] = await Promise.all([quote(sku), stock(sku), payments.get(`/balances/${req.query.account}`)]);
  res.json({ price, left, balance: balance.data });
});

// GET /products/:sku: the product page.
app.get('/products/:sku', async (req, res) => {
  const sku = req.params.sku;
  const [item, ship, info, fx] = await Promise.all([inventory.get(`/items/${sku}`), shipping.get(`rates/${sku}`).json(), catalog.get(`products/${sku}`).json(), rates()]);
  res.json({ item: item.data, ship, info, fx });
});

app.listen(3000);
