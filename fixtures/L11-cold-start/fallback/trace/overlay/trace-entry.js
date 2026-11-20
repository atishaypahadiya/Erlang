// The L11 fallback form's entry: the L11 trace form's, without its neutral
// warm-up route, so the harness falls back to a path that does not exist.
// The L11 trace form's entry. The static pair ships small stand-ins for the
// work its values take to build: a three-line postcode file and a tiny PDF
// module. A trace judges a first request against later ones by time, so
// this makes the work its real size before importing the twin's src/app.js
// unchanged: data/regions.csv gets 600,000 postcodes (written once, like a
// seed), and trace/overlay/src/render/pdf.js, which replaces the twin's
// stand-in, builds its tables when it loads, as a large library does. The
// country list's size comes from trace/seed.sql. Part of the trace form, not
// of the twins: scripts/trace/run.js copies trace/overlay over the twin's copy.
import { statSync, writeFileSync } from 'node:fs';

const csv = new URL('./data/regions.csv', import.meta.url);
if (statSync(csv).size < 1_000_000) {
  const regions = ['scotland', 'wales', 'england', 'northern-ireland'];
  const lines = ['postcode,region'];
  for (let i = 0; i < 600_000; i++) lines.push(`P${i},${regions[i % 4]}`);
  writeFileSync(csv, lines.join('\n') + '\n');
}
export const { app } = await import('./src/app.js');
