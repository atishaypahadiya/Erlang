-- The Prisma schema's tables (quoted, as Prisma names them): 10 x :scale
-- customers, products and orders, so every row a request names exists, and
-- the foreign keys Prisma's relations make hold. No randomness.
insert into "Customer" ("email", "name")
  select 'c' || i || '@example.test', 'Customer ' || i from generate_series(1, 10 * :scale) i;
insert into "Product" ("sku", "name", "price")
  select 'sku-' || i, 'Product ' || i, 100 + i from generate_series(1, 10 * :scale) i;
insert into "Order" ("customerId", "total")
  select i, 1000 + i from generate_series(1, 10 * :scale) i;
