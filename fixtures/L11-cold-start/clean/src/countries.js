import { pool } from './db.js';

// The shop's countries and their VAT rates, from the database.
const countries = (await pool.query('select code, name, vat from countries order by name')).rows;
// The list as JSON bytes, made with the rows: what GET /checkout/countries sends.
const countriesJson = Buffer.from(JSON.stringify(countries));

export async function countryList() {
  // Built when the module loads, before the app listens.
  return countriesJson;
}
