-- The tables the L01b SQL twins write. Not part of the twins: they ship no
-- migration, so the trace form supplies one.
create table customers (
  id serial primary key,
  email text not null,
  name text not null
);

create table products (
  id serial primary key,
  sku text not null unique,
  stock int not null default 0
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

create table tags (
  id serial primary key,
  product_id int not null references products (id),
  name text not null
);
create index tags_product_id on tags (product_id);

create table teams (
  id serial primary key,
  name text not null
);

create table roles (
  id serial primary key,
  team_id int not null references teams (id),
  name text not null
);
create index roles_team_id on roles (team_id);
