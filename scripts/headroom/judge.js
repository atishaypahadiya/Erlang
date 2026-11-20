// Judges one load form's headroom (scripts/trace/run.js --headroom): the
// clean twin's main-thread busy share at each load step's rate must be at
// most HEADROOM_MAX (the owner, 20 November 2026). Over it, the clean twin
// is near saturation and a verdict that compares the twins under load turns
// on the runner's speed (L09's export, CI run 44682458078).
//
// Usage: node scripts/headroom/judge.js <form dir> <out dir>
// Exit codes: 0 every step within the bar, 1 a step over it, 64 bad usage,
// 70 internal failure.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { exitOnCrash } from '../../lib/crash.js';

exitOnCrash('headroom judge');

export const HEADROOM_MAX = 0.2;
const [formDir, outDir] = process.argv.slice(2);
if (!formDir || !outDir) { console.error('usage: node scripts/headroom/judge.js <form dir> <out dir>'); process.exit(64); }
const file = join(outDir, 'headroom.json');
if (!existsSync(file)) { console.log(`FAIL  ${formDir}: no headroom.json: run scripts/trace.sh --headroom`); process.exit(1); }
const h = JSON.parse(readFileSync(file, 'utf8'));
const fmt = (x) => x.toFixed(2);
// Only judged steps can fail it (the owner, 20 November 2026); an unjudged
// step (a warm-up, no metric) is printed with its figures and marked so. A
// row with no "judged" field is judged.
const judged = (r) => r.judged !== false;
let over = 0;
for (const r of h.rows) {
  const ok = !judged(r) || r.busy <= HEADROOM_MAX;
  if (!ok) over++;
  console.log(`HEADROOM  ${h.fixture} ${h.form} clean ${r.step}: ${r.rate}/s x ${fmt(r.ms)} ms (${r.method} ${r.path})${r.background ? ` + ${r.background.rate}/s x ${fmt(r.background.ms)} ms (${r.background.method} ${r.background.path})` : ''} = busy ${r.busy.toFixed(3)}${!judged(r) ? ' (unjudged step: printed, not failed)' : ok ? '' : `, over ${HEADROOM_MAX}`}`);
}
const max = Math.max(0, ...h.rows.filter(judged).map((r) => r.busy));
console.log(`${over ? 'FAIL' : 'PASS'}  ${h.fixture} ${h.form} headroom: the clean twin's main thread is busy at most ${max.toFixed(3)} of the time at any judged step's rate (bar ${HEADROOM_MAX})${over ? `; ${over} step(s) over` : ''}`);
process.exit(over ? 1 : 0);
