-- The tables the L13 compose twins read (scripts/migrate.js makes orders;
-- daily_totals is the reporting view's table).
create table orders (id serial primary key, total int not null);
create table daily_totals (day date primary key, total int not null);
