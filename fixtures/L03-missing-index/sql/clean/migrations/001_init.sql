create table users (
  id bigserial primary key,
  email text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table events (
  id bigserial primary key,
  user_id bigint not null references users (id),
  kind text not null,
  created_at timestamptz not null default now()
);

create table orders (
  id bigserial primary key,
  user_id bigint not null references users (id),
  status text not null,
  total_cents integer not null,
  created_at timestamptz not null default now()
);
create index orders_user_id_idx on orders (user_id);

create table order_items (
  id bigserial primary key,
  order_id bigint not null references orders (id),
  sku text not null,
  qty integer not null
);

create table audit_log (
  id bigserial primary key,
  actor_id bigint not null references users (id),
  action text not null,
  at timestamptz not null default now()
);

-- Lookup tables: small and fixed.
create table countries (
  code text primary key,
  name text not null
);
