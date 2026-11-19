-- The Prisma schema's tables (quoted, as Prisma names them): 2,000 x :scale
-- users (every other one on the PRO plan, nine in ten active) with 20 events
-- each, 5 orders each (one in the last hour per 200 users) and 2 items per
-- order; 250 countries, which stay small at every scale, as the owner's
-- smallTables says. No randomness.
insert into "User" ("email", "active", "plan")
  select 'u' || i || '@example.test', i % 10 <> 0, (case when i % 2 = 0 then 'PRO' else 'FREE' end)::"Plan" from generate_series(1, 2000 * :scale) i;
insert into "Event" ("userId", "kind", "createdAt")
  select 1 + (i - 1) / 20, 'kind-' || i % 7, timestamp '2026-01-01' + i * interval '1 minute' from generate_series(1, 40000 * :scale) i;
insert into "Order" ("userId", "status", "totalCents", "createdAt")
  select 1 + (i - 1) / 5, case when i % 3 = 0 then 'paid' else 'new' end, 1000 + i,
    case when i % 1000 = 0 then timestamp '2026-11-01 12:00' else timestamp '2026-01-01' + i * interval '1 second' end
  from generate_series(1, 10000 * :scale) i;
insert into "OrderItem" ("orderId", "sku", "qty")
  select 1 + (i - 1) / 2, 'sku-' || i % 97, 1 + i % 3 from generate_series(1, 20000 * :scale) i;
insert into "Country" ("code", "name") select 'C' || i, 'Country ' || i from generate_series(1, 250) i;
