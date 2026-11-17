// core/ is a read-only copy of KERCKHOFFS's core/ (core.pin.json), until the
// shared core is extracted into its own repository. This test fails if any
// copied file differs from its recorded SHA-256, or if a file is added to or
// missing from core/: a change to the shared contract belongs in the source,
// then is copied here again.
//
// Usage: node scripts/core-pin-test.js       exit 0 when core/ matches the pin

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(readFileSync(join(ROOT, 'core.pin.json'), 'utf8'));
const onDisk = readdirSync(join(ROOT, 'core'), { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => relative(ROOT, join(e.parentPath, e.name)).split(sep).join('/'))
  .sort();

let failed = 0;
const ok = (name, cond, detail = '') => { if (!cond) failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

for (const [file, hash] of Object.entries(pin.files)) {
  let actual = null;
  try { actual = createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex'); } catch { /* missing */ }
  ok(`${file} matches ${pin.source} ${pin.commit.slice(0, 7)}`, actual === hash, actual === hash ? '' : actual ? 'changed' : 'missing');
}
for (const file of onDisk.filter((f) => !(f in pin.files))) ok(`${file} is part of the pinned copy`, false, 'not in core.pin.json');

console.log(failed ? `\n${failed} core file(s) differ from the pin` : `\ncore/ matches ${pin.source} ${pin.commit.slice(0, 7)} (temporary copy)`);
process.exit(failed ? 1 : 0);
