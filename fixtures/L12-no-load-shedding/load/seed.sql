-- 1,000 orders. No randomness.
insert into order_rows (id, total_cents, created_at)
  select i, 1000 + i, timestamptz '2026-01-01' + i * interval '1 hour' from generate_series(1, 1000) i;
