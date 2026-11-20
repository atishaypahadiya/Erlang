import { pool } from './db.js';

// The shop's countries and their VAT rates, from the database.
let countries = null;
// The list as JSON bytes, made with the rows: what GET /checkout/countries sends.
let countriesJson = null;

export async function countryList() {
  if (countries === null) {
    countries = (await pool.query('select code, name, vat from countries order by name')).rows;
    countriesJson = Buffer.from(JSON.stringify(countries));
  }
  return countriesJson;
}
