import { readFile } from 'node:fs/promises';

// Postcode to tax region, one entry per postcode in data/regions.csv.
const regions = await loadRegions();

async function loadRegions() {
  const map = new Map();
  for (const line of (await readFile(new URL('../data/regions.csv', import.meta.url), 'utf8')).split('\n').slice(1)) {
    const [postcode, region] = line.split(',');
    if (postcode) map.set(postcode, region);
  }
  return map;
}

export async function regionOf(postcode) {
  // Built when the module loads, before the app listens.
  return regions.get(postcode) ?? null;
}
