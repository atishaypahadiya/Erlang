-- 100 x :scale customers with 10 orders each, so a whole-table aggregate
-- grows with the scale and one customer's does not; order 1 has 5 lines;
-- 500 x :scale refunds; one finished export. No randomness.
insert into customers (name) select 'Customer ' || i from generate_series(1, 100 * :scale) i;
insert into orders (customer_id, total_cents) select 1 + (i - 1) / 10, 1000 + i from generate_series(1, 1000 * :scale) i;
insert into products (name, price_cents) select 'Product ' || i, 100 + i from generate_series(1, 200) i;
insert into order_lines (order_id, product_id, quantity, price_cents) select 1, i, 1 + i % 3, 100 + i from generate_series(1, 5) i;
insert into tax_rates (region, rate) values ('eu', 0.2), ('uk', 0.2), ('us', 0.07);
insert into settings (name, value) values ('currency', 'EUR');
insert into accounts (balance_cents) values (0);
insert into refunds (amount_cents) select 100 + i % 50 from generate_series(1, 500 * :scale) i;
insert into exports (done) values (true);
refresh materialized view order_totals;
