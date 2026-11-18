import { readFileSync, readdirSync } from 'node:fs';

// Read once, when the module loads: no request waits on these.
export const PLACEHOLDER = readFileSync(new URL('../assets/placeholder.png', import.meta.url));

export function loadTemplates() {
  const dir = new URL('../templates/', import.meta.url);
  return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(new URL(name, dir), 'utf8')]));
}
