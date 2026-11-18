create table customers (
  id serial primary key,
  email text not null unique,
  name text not null
);

create table orders (
  id serial primary key,
  customer_id int not null references customers (id),
  total int not null,
  status text not null default 'new'
);

create table events (
  id bigserial primary key,
  kind text not null,
  created_at timestamptz not null default now()
);

create table products (
  id serial primary key,
  sku text not null,
  name text not null
);
create unique index products_sku on products (sku);

create table settings (
  key text primary key,
  value text not null
);
