-- 10 x :scale customers, products and orders, one customer per order; order 1
-- has 10 x :scale items. No randomness: the same scale gives the same rows.
insert into customers (name, email)
  select 'Customer ' || i, 'c' || i || '@example.test' from generate_series(1, 10 * :scale) i;
insert into products (sku, name, price)
  select 'sku-' || i, 'Product ' || i, 100 + i from generate_series(1, 10 * :scale) i;
insert into orders (customer_id, total)
  select i, 1000 + i from generate_series(1, 10 * :scale) i;
insert into line_items (order_id, product_id, quantity)
  select 1, i, 1 + i % 3 from generate_series(1, 10 * :scale) i;
insert into settings (key, value) values ('currency', 'EUR'), ('locale', 'en-GB'), ('timezone', 'Europe/London');
