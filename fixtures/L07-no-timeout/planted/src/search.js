import { searchDefaults } from 'search-sdk/defaults';

const BASE = process.env.SEARCH_URL;

export async function search(q) {
  const res = await fetch(`${BASE}/search?q=${encodeURIComponent(q)}`, { ...searchDefaults });
  return res.json();
}
