-- The Prisma schema's one table: ten orders. No randomness.
insert into "Order" ("total", "status")
  select 1000 + i, case when i % 2 = 0 then 'paid' else 'new' end from generate_series(1, 10) i;
