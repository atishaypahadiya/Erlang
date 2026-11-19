import { pool } from './db.js';

// The shop's countries and their VAT rates, from the database.
let countries = null;

export async function countryList() {
  if (countries === null) countries = (await pool.query('select code, name, vat from countries order by name')).rows;
  return countries;
}
