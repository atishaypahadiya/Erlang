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

// The neutral warm-up route (trace.json "warmup"): a POST with a JSON body,
// read by the twin's own body parser, and one read through the twin's own
// pool, so the start-up cost every first request pays (Express's first
// dispatch, the body parser's first body, which loads its character
// decoders, pg's protocol and row parsing, the runtime's work still going
// on after listen) is paid before any route is measured. It also reads the
// orders and settings tables, writing nothing.
const { pool } = await import('./src/db.js');
app.post('/__trace/warm', async (req, res) => {
  // Reads, never writes, of the tables POST /orders uses, so the database
  // connection holds them before any route is measured (the owner, 20
  // November 2026).
  await pool.query('select 1 as one');
  await pool.query("select value from settings where name = 'default_note'");
  await pool.query('select id, note from orders order by id limit 1');
  res.json({ ok: req.body?.warm === true });
});
