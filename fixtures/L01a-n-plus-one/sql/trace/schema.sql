-- The tables the L01a SQL twins read. Not part of the twins: they ship no
-- migration, so the trace form supplies one.
create table customers (
  id serial primary key,
  name text not null,
  email text not null
);

create table products (
  id serial primary key,
  sku text not null unique,
  name text not null,
  price int not null
);

create table orders (
  id serial primary key,
  customer_id int not null references customers (id),
  total int not null
);
create index orders_customer_id on orders (customer_id);

create table line_items (
  id serial primary key,
  order_id int not null references orders (id),
  product_id int not null references products (id),
  quantity int not null
);
create index line_items_order_id on line_items (order_id);
create index line_items_product_id on line_items (product_id);

create table settings (
  key text primary key,
  value text not null
);
