// The timing lock, shared with ITTEN and KERCKHOFFS: a finding that rests on
// a timing counts only when the timing is trustworthy. Trustworthy means:
//   - measured at least 3 times;
//   - the relative spread of the samples, (max - min) / median, is at most
//     10%;
//   - the 1-minute load average was below half the CPU count both before and
//     after the measurement.
// Otherwise the finding is info, with reason "timing unreliable", and the
// environment is recorded with it. It never fails a run. The load harness
// applies this to every load finding.

import { loadavg, cpus } from 'node:os';

export const MIN_SAMPLES = 3;
export const MAX_SPREAD = 0.10;
export const REASON = 'timing unreliable';

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The machine as it is now: the 1-minute load average and the CPU count.
export function environment() {
  return { load1: Number(loadavg()[0].toFixed(2)), cpus: cpus().length };
}

// judge({ samples, before, after }) where before and after are environment()
// readings. Gives { reliable, reason, why, samples, median, spread, before,
// after }; why lists each condition that failed.
export function judge({ samples, before, after }) {
  const why = [];
  const xs = (samples ?? []).filter((x) => Number.isFinite(x));
  const med = xs.length ? median(xs) : null;
  const spread = xs.length && med > 0 ? (Math.max(...xs) - Math.min(...xs)) / med : null;
  if (xs.length < MIN_SAMPLES) why.push(`${xs.length} sample(s), fewer than ${MIN_SAMPLES}`);
  else if (spread === null || spread > MAX_SPREAD) why.push(`spread ${spread === null ? 'unknown' : `${(spread * 100).toFixed(1)}%`}, over ${MAX_SPREAD * 100}%`);
  for (const [when, env] of [['before', before], ['after', after]]) {
    if (!env || !Number.isFinite(env.load1) || !env.cpus) why.push(`load average ${when} unknown`);
    else if (env.load1 >= env.cpus / 2) why.push(`load average ${env.load1} ${when}, not below half of ${env.cpus} CPUs`);
  }
  return { reliable: why.length === 0, reason: why.length ? REASON : null, why, samples: xs, median: med, spread, before: before ?? null, after: after ?? null };
}

// A finding's severity under the lock: its own when the timing is reliable,
// info otherwise.
export const severityUnder = (severity, verdict) => (verdict.reliable ? severity : 'info');

// Candidate rule (c) (docs/decisions.md, Q8; on trial, not the rule), for a timed
// verdict that compares two conditions within each repeat (the twins in one
// pair, or two requests in one run): at least MIN_REPEATS repeats; it holds
// when every repeat clears the threshold on its own, there is no finding
// when none does, and a mix is unreliable. Spread and load average are
// recorded, never consulted. clears: one boolean per repeat; samples: the
// quantities behind them, for the record.
export const MIN_REPEATS = 5;
export function ruleC({ clears, samples, before, after }) {
  const why = [];
  const n = clears.filter(Boolean).length;
  if (clears.length < MIN_REPEATS) why.push(`${clears.length} repeat(s), fewer than ${MIN_REPEATS}`);
  else if (n && n < clears.length) why.push(`${n} of ${clears.length} repeats cleared the threshold`);
  const xs = (samples ?? []).filter((x) => Number.isFinite(x));
  const med = xs.length ? median(xs) : null;
  const spread = xs.length && med > 0 ? (Math.max(...xs) - Math.min(...xs)) / med : null;
  return { holds: n > 0, timing: { reliable: why.length === 0, reason: why.length ? REASON : null, why, samples: xs, median: med, spread, before: before ?? null, after: after ?? null } };
}
