-- The Prisma schema's tables (quoted, as Prisma names them): 1,000 x :scale
-- customers and products, 10,000 x :scale orders (every other one paid) and
-- events, and three settings, which do not grow. No randomness.
insert into "Customer" ("email", "name")
  select 'c' || i || '@example.test', 'Customer ' || i from generate_series(1, 1000 * :scale) i;
insert into "Product" ("sku", "name")
  select 'sku-' || i, 'Product ' || i from generate_series(1, 1000 * :scale) i;
insert into "Order" ("customerId", "total", "status")
  select 1 + i % (1000 * :scale), 1000 + i % 500, case when i % 2 = 0 then 'paid' else 'new' end
  from generate_series(1, 10000 * :scale) i;
insert into "Event" ("kind", "createdAt")
  select case when i % 3 = 0 then 'login' else 'view' end, timestamp '2026-01-01 00:00:00' + i * interval '1 minute'
  from generate_series(1, 10000 * :scale) i;
insert into "Setting" ("key", "value") values ('currency', 'EUR'), ('locale', 'en-GB'), ('timezone', 'Europe/London');
