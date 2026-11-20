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
// The median of a step's measurements is judged against HEADROOM_MAX, and two
// or more measurements over HEADROOM_ONE fail outright (the owner, 20
// November 2026; docs/CONTRACT.md, "Margins in the fixture suite"): a one-off
// stall on a shared runner moves one measurement, not the median, and a
// single one over HEADROOM_ONE is printed as an OUTLIER with its collection
// time; requests that hold the main thread a third of the time again and
// again are a real lack of headroom.
export const HEADROOM_ONE = 0.3;
export const HEADROOM_ONE_TIMES = 2;
const [formDir, outDir] = process.argv.slice(2);
if (!formDir || !outDir) { console.error('usage: node scripts/headroom/judge.js <form dir> <out dir>'); process.exit(64); }
const file = join(outDir, 'headroom.json');
if (!existsSync(file)) { console.log(`FAIL  ${formDir}: no headroom.json: run scripts/trace.sh --headroom`); process.exit(1); }
const h = JSON.parse(readFileSync(file, 'utf8'));
const fmt = (x) => x.toFixed(2);
// Only judged steps can fail it (the owner, 20 November 2026); an unjudged
// step (a warm-up, no metric) is printed with its figures and marked so. A
// row with no "judged" field is judged. A row with no busyEach (an older
// headroom.json) is one measurement, its busy.
const judged = (r) => r.judged !== false;
const eachOf = (r) => r.busyEach ?? [r.busy];
let over = 0;
for (const r of h.rows) {
  const each = eachOf(r);
  const single = each.filter((b) => b > HEADROOM_ONE);
  const ok = !judged(r) || (r.busy <= HEADROOM_MAX && single.length < HEADROOM_ONE_TIMES);
  if (!ok) over++;
  const gc = r.each ? `; collections ${r.each.reduce((a, x) => a + x.gcs, 0)}, ${fmt(r.each.reduce((a, x) => a + x.gcMs, 0))} ms in the step's ${r.each.length} requests` : '';
  const why = [r.busy > HEADROOM_MAX ? `median over ${HEADROOM_MAX}` : null, single.length >= HEADROOM_ONE_TIMES ? `${single.length} measurements over ${HEADROOM_ONE}` : null].filter(Boolean).join(', ');
  console.log(`HEADROOM  ${h.fixture} ${h.form} clean ${r.step}: ${r.rate}/s x ${fmt(r.ms)} ms (${r.method} ${r.path})${r.background ? ` + ${r.background.rate}/s x ${fmt(r.background.ms)} ms (${r.background.method} ${r.background.path})` : ''} = busy ${r.busy.toFixed(3)} (median of ${each.length}; max ${Math.max(...each).toFixed(3)})${gc}${!judged(r) ? ' (unjudged step: printed, not failed)' : ok ? '' : `: ${why}`}`);
  if (judged(r) && single.length === 1) {
    const k = each.findIndex((b) => b > HEADROOM_ONE);
    console.log(`OUTLIER  ${h.fixture} ${h.form} clean ${r.step}: measurement ${k + 1} of ${each.length} busy ${each[k].toFixed(3)}, over ${HEADROOM_ONE} once (not failed; ${HEADROOM_ONE_TIMES} or more fail)${r.each ? `: ${r.each[k].ms} ms, of it ${r.each[k].gcMs} ms in ${r.each[k].gcs} collection(s)` : ''}${r.background?.each ? `; background ${r.background.each[k].ms} ms, ${r.background.each[k].gcMs} ms collecting` : ''}`);
  }
  if (r.each && Math.max(...each) > HEADROOM_MAX) console.log(`          ${r.step} measurements: busy ${JSON.stringify(each)}; ms ${JSON.stringify(r.each.map((x) => x.ms))}; collection ms ${JSON.stringify(r.each.map((x) => x.gcMs))}${r.background?.each ? `; background ms ${JSON.stringify(r.background.each.map((x) => x.ms))}, collection ms ${JSON.stringify(r.background.each.map((x) => x.gcMs))}` : ''}`);
}
const max = Math.max(0, ...h.rows.filter(judged).map((r) => r.busy));
console.log(`${over ? 'FAIL' : 'PASS'}  ${h.fixture} ${h.form} headroom: the clean twin's main thread is busy at most ${max.toFixed(3)} of the time at any judged step's rate, on the median (bar ${HEADROOM_MAX}; fewer than ${HEADROOM_ONE_TIMES} measurements over ${HEADROOM_ONE})${over ? `; ${over} step(s) over` : ''}`);
process.exit(over ? 1 : 0);
