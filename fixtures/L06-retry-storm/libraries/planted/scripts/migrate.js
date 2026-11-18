// Run once before the app starts; no request waits on it.
import pRetry from 'p-retry';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await pRetry(() => client.connect(), { retries: 5 });
await client.query('create table if not exists orders (id serial primary key, sku text not null)');
await client.end();
