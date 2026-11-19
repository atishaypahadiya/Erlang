// Run by hand: checks data/regions.csv for duplicate postcodes. No request runs it.
import { readFile } from 'node:fs/promises';

let seen;

async function main() {
  if (!seen) seen = new Set((await readFile(new URL('../data/regions.csv', import.meta.url), 'utf8')).split('\n').map((l) => l.split(',')[0]));
  console.log(`${seen.size} postcodes`);
}

await main();
