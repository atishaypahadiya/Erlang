-- L12's load form. The twins read one order by its key, which takes about a
-- millisecond: their pool of 10 (src/db.js) would then serve some 10,000
-- requests a second, past every cap on load. Here every read of an order
-- takes 100 ms at the database instead, as a heavier query would, so the
-- pool serves at most 100 a second and the knee sits there on any machine.
-- The twins are unchanged.
create table order_rows (
  id bigint primary key,
  total_cents integer not null,
  created_at timestamptz not null
);
create view orders as
  select o.id, o.total_cents, o.created_at
  from order_rows o cross join lateral (select pg_sleep(0.1)) as slow;
