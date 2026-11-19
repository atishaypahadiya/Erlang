-- 1,000 orders and 31 days of totals. :scale is unused: L13 is judged on
-- connections opened, which do not grow with data.
insert into orders (total) select 1000 + i from generate_series(1, 1000) i;
insert into daily_totals (day, total) select current_date - i, 100 * i from generate_series(0, 30) i;
