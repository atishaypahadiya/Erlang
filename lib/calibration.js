// The calibration probe (on trial, docs/decisions.md Q6; not yet the rule): a
// short fixed workload, run before and after each judged step, whose own
// timings show whether the machine changed under the measurement. A step is
// reliable when every probe around it agrees within MAX_DISAGREEMENT, for the
// CPU part and the I/O part separately. The load average is still recorded,
// as information.
//
// CPU: SHA-256 over a fixed 4 MiB buffer, 64 times. I/O: 64 MiB written in
// 1 MiB chunks to a file in the run's output folder, fsync'd, read back and
// removed. Each probe discards one warm-up run, then runs the pair PROBE_RUNS
// times and keeps the median of each part, so one stray scheduling hiccup
// does not decide it.

import { createHash } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_DISAGREEMENT = 0.10;
const PROBE_RUNS = 3;
const MIB = 1024 * 1024;
const BLOCK = Buffer.alloc(4 * MIB, 0);
for (let k = 0; k < BLOCK.length; k++) BLOCK[k] = (k * 2654435761) >>> 24;
const CHUNK = BLOCK.subarray(0, MIB);

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function once(dir) {
  let t0 = process.hrtime.bigint();
  for (let k = 0; k < 64; k++) createHash('sha256').update(BLOCK).digest();
  const cpuMs = ms(t0);
  const file = join(dir, `calibration-${process.pid}.bin`);
  t0 = process.hrtime.bigint();
  const fd = openSync(file, 'w');
  try {
    for (let k = 0; k < 64; k++) writeSync(fd, CHUNK);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  readFileSync(file);
  rmSync(file, { force: true });
  const ioMs = ms(t0);
  return { cpuMs, ioMs };
}

// One probe: { cpuMs, ioMs }, medians of PROBE_RUNS runs. dir is the run's
// output folder (outputs go to dist/, never /tmp).
export function probe(dir) {
  once(dir);
  const runs = Array.from({ length: PROBE_RUNS }, () => once(dir));
  return { cpuMs: Number(median(runs.map((r) => r.cpuMs)).toFixed(2)), ioMs: Number(median(runs.map((r) => r.ioMs)).toFixed(2)) };
}

// The verdict over the probes taken around a step (or a set of steps):
// reliable when, for CPU and for I/O, (max - min) / median is at most
// MAX_DISAGREEMENT. Fewer than two probes cannot agree.
export function agree(probes) {
  const xs = (probes ?? []).filter((p) => p && Number.isFinite(p.cpuMs) && Number.isFinite(p.ioMs));
  const why = [];
  const part = (k) => {
    const v = xs.map((p) => p[k]);
    const m = median(v);
    return m > 0 ? (Math.max(...v) - Math.min(...v)) / m : null;
  };
  if (xs.length < 2) why.push(`${xs.length} probe(s), fewer than 2`);
  const cpu = xs.length >= 2 ? part('cpuMs') : null;
  const io = xs.length >= 2 ? part('ioMs') : null;
  if (cpu !== null && cpu > MAX_DISAGREEMENT) why.push(`probe CPU times disagree by ${(cpu * 100).toFixed(1)}%, over ${MAX_DISAGREEMENT * 100}%`);
  if (io !== null && io > MAX_DISAGREEMENT) why.push(`probe I/O times disagree by ${(io * 100).toFixed(1)}%, over ${MAX_DISAGREEMENT * 100}%`);
  return { reliable: why.length === 0, cpu, io, probes: xs.length, why };
}
