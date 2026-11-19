-- The Prisma schema's tables (quoted, as Prisma names them): 10 x :scale
-- customers, products, orders (one customer each) and unpaid invoices (one
-- customer each); order 1 has 10 x :scale items. No randomness.
insert into "Customer" ("name", "email")
  select 'Customer ' || i, 'c' || i || '@example.test' from generate_series(1, 10 * :scale) i;
insert into "Product" ("sku", "name", "price")
  select 'sku-' || i, 'Product ' || i, 100 + i from generate_series(1, 10 * :scale) i;
insert into "Order" ("customerId", "total")
  select i, 1000 + i from generate_series(1, 10 * :scale) i;
insert into "LineItem" ("orderId", "productId", "quantity")
  select 1, i, 1 + i % 3 from generate_series(1, 10 * :scale) i;
insert into "Invoice" ("customerId", "amount")
  select i, 500 + i from generate_series(1, 10 * :scale) i;
insert into "Setting" ("key", "value") values ('currency', 'EUR'), ('locale', 'en-GB'), ('timezone', 'Europe/London');
