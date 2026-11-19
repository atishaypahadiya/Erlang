-- 10 orders, each with one item. :scale is unused: L08 is judged on pool
-- counts, which do not grow with data.
insert into orders (total) select 1000 + i from generate_series(1, 10) i;
insert into line_items (order_id, sku, quantity) select i, 'sku-' || i, 1 from generate_series(1, 10) i;
