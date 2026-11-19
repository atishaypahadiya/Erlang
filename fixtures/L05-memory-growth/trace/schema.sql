-- The tables the L05 twins use. Not part of the twins: they ship no
-- migration, so the trace form supplies one.
create table products (id serial primary key, name text not null);
create table orders (id serial primary key, total_cents int not null, currency text not null);
create table order_lines (order_id int not null, product_id int not null, quantity int not null);
