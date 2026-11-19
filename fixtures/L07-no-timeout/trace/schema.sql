-- The table src/db.js reads.
create table orders (id serial primary key, user_id int not null, total int not null);
