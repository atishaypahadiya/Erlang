import { readFile } from 'node:fs/promises';

// Postcode to tax region, one entry per postcode in data/regions.csv.
let regions = null;

async function loadRegions() {
  const map = new Map();
  for (const line of (await readFile(new URL('../data/regions.csv', import.meta.url), 'utf8')).split('\n').slice(1)) {
    const [postcode, region] = line.split(',');
    if (postcode) map.set(postcode, region);
  }
  return map;
}

export async function regionOf(postcode) {
  if (!regions) regions = await loadRegions();
  return regions.get(postcode) ?? null;
}
