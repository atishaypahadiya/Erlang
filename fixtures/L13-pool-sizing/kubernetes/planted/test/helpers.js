// Test helpers: a client for the test database.
import pg from 'pg';

export const testPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
