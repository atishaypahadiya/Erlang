-- The tables the L11 twins read. Not part of the twins: they ship no
-- migration, so the trace form supplies one.
create table countries (code text primary key, name text not null, vat numeric not null);
create table holidays (day text primary key);
create table delivery_days (region text primary key, days int not null);
create table invoices (id serial primary key, total_cents int not null);
create table fx (pair text primary key, rate numeric not null);
create table products (id serial primary key, price_pence int not null);
create table settings (name text primary key, value text not null);
create table orders (id serial primary key, note text not null);
