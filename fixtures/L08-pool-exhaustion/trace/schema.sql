-- The tables the L08 twins use. Not part of the twins: they ship no
-- migration, so the trace form supplies one. refunds has no created_at on
-- purpose: GET /reports/daily's second read fails, which is how the trace
-- reaches the error path the planted twin never releases on.
create table orders (
  id serial primary key,
  total int not null,
  status text not null default 'new',
  paid_at timestamptz,
  charge_id text,
  shipped_at timestamptz,
  created_at timestamptz not null default now()
);
create table line_items (order_id int not null, sku text not null, quantity int not null);
create table shipments (order_id int not null, reservation_id text not null);
create table refunds (order_id int not null, refund_id text not null);
create table imports (payload jsonb not null, batch_id int);
