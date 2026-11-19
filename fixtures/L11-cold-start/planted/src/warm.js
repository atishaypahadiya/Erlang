import { pool } from './db.js';

// Public holidays, loaded once by warm(), which app.js calls before it listens.
let holidays = null;

export async function warm() {
  if (!holidays) holidays = (await pool.query('select day from holidays')).rows.map((r) => r.day);
}

export const isHoliday = (day) => holidays?.includes(day) ?? false;
