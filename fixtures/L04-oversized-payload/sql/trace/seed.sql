-- 10 x :scale products, each with a 51,200-character description (about the
-- 50 KB fixtures/PLAN.md gives L04). No randomness.
insert into products (name, price_cents, description)
  select 'Product ' || i, 100 + i, repeat(md5(i::text), 1600) from generate_series(1, 10 * :scale) i;
