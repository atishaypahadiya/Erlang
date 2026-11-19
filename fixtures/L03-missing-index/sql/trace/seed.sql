-- 2,000 x :scale users with 20 events each, 5 orders each (one in the last
-- hour per 200 users) and 2 items per order; 250 countries. The countries
-- stay small at every scale, as the owner's smallTables says. No randomness.
insert into users (email, active) select 'u' || i || '@example.test', i % 10 <> 0 from generate_series(1, 2000 * :scale) i;
insert into events (user_id, kind, created_at) select 1 + (i - 1) / 20, 'kind-' || i % 7, timestamptz '2026-01-01' + i * interval '1 minute' from generate_series(1, 40000 * :scale) i;
insert into orders (user_id, status, total_cents, created_at) select 1 + (i - 1) / 5, case when i % 3 = 0 then 'paid' else 'new' end, 1000 + i, case when i % 1000 = 0 then timestamptz '2026-11-01 12:00' else timestamptz '2026-01-01' + i * interval '1 second' end from generate_series(1, 10000 * :scale) i;
insert into order_items (order_id, sku, qty) select 1 + (i - 1) / 2, 'sku-' || i % 97, 1 + i % 3 from generate_series(1, 20000 * :scale) i;
insert into audit_log (actor_id, action) select 1 + i % (2000 * :scale), 'login' from generate_series(1, 1000 * :scale) i;
insert into countries (code, name) select 'C' || i, 'Country ' || i from generate_series(1, 250) i;
