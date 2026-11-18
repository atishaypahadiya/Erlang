// Run by the migrate service once, before the api starts.
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query('create table if not exists orders (id serial primary key, total int not null)');
await client.end();
