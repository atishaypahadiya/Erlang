-- 200 products, every name containing "a", so each search returns 50 rows;
-- order 1 has 5 lines. :scale is unused: L05 is judged on heap per request.
insert into products (name) select 'Product a' || i from generate_series(1, 200) i;
insert into orders (total_cents, currency) values (100, 'EUR');
insert into order_lines (order_id, product_id, quantity) select 1, i, 1 from generate_series(1, 5) i;
