-- The tables the L10 twins read. Not part of the twins: they ship no
-- migration, so the trace form supplies one.
create table customers (id serial primary key, name text not null);
create table orders (id serial primary key, customer_id int not null references customers (id), total_cents int not null);
create index on orders (customer_id);
create table products (id serial primary key, name text not null, price_cents int not null);
create table order_lines (order_id int not null references orders (id), product_id int not null references products (id), quantity int not null, price_cents int not null);
create index on order_lines (order_id);
create table tax_rates (region text primary key, rate numeric not null);
create table settings (name text primary key, value text not null);
create table accounts (id serial primary key, balance_cents int not null);
create table refunds (id serial primary key, amount_cents int not null);
create table exports (id serial primary key, done boolean not null);
create materialized view order_totals as select customer_id, count(*) as n, sum(total_cents) as total from orders group by customer_id;
