-- 10 x :scale customers and products, and one order for items to be added
-- to: every row a request names exists. No randomness.
insert into customers (email, name)
  select 'c' || i || '@example.test', 'Customer ' || i from generate_series(1, 10 * :scale) i;
insert into products (sku, stock)
  select 'sku-' || i, 10 from generate_series(1, 10 * :scale) i;
insert into orders (customer_id, total) values (1, 0);
