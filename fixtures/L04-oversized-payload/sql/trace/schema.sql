-- The products table the L04 twins read. Not part of the twins: they ship no
-- migration, so the trace form supplies one.
create table products (
  id serial primary key,
  name text not null,
  price_cents int not null,
  description text not null
);
