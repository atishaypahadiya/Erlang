// Margins in the fixture suite (the owner, 20 November 2026; docs/CONTRACT.md,
// "Margins in the fixture suite"). A row's samples are judged on their
// median against the margin, and each sample on its own against the judge's
// own bar:
//   - a decoy keeps its margin when, for some condition of its bar, the
//     median over the samples is at most half way to the bar; it fails if
//     any single sample reaches the bar (clears every condition, as a
//     finding would);
//   - a planted row keeps its margin when, for every condition, the median
//     is at least the margin (2x the bar; for a share, half way to 1); it
//     fails if any single sample falls below the bar;
//   - a sample past the margin but inside the bar is an outlier: printed,
//     with its diagnostics, not failed.
// One-off stalls on a shared runner move one sample, not the median.
//
// A condition is { what, of(x) -> value, bar(x) -> the judge's threshold,
// margin(x) -> the margin's threshold }. Thresholds may differ per sample (a
// ratio times the other twin's value in the same pair), so values are
// compared to their threshold as a quotient: 1 at the threshold.

export function median(xs) {
  const s = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// value / threshold, with a threshold of 0 or less handled by side: at or
// under it is 0, over it is Infinity.
export function against(v, t) {
  if (t > 0) return v / t;
  return v <= t ? 0 : Infinity;
}

const over = (c, x, which) => c.of(x) >= c[which](x);
const under = (c, x, which) => c.of(x) <= c[which](x);

// clears(x), when given, is the judge's own test of a sample against its bar
// (load mode adds "positive" to the conditions); else every condition at or
// past its bar.
const clearsOf = (conds, clears) => clears ?? ((x) => conds.every((c) => over(c, x, 'bar')));

// A decoy row. Returns { ok, kept, reached, outliers, medians }: kept, the
// median rule; reached, indices of samples at or past the judge's bar on
// every condition; outliers, indices past the margin on every condition but
// not reaching the bar.
export function decoyMargin(samples, conds, clears) {
  const bar = clearsOf(conds, clears);
  const medians = conds.map((c) => median(samples.map((x) => against(c.of(x), c.margin(x)))));
  const kept = medians.some((m) => m <= 1);
  const reached = [];
  const outliers = [];
  samples.forEach((x, i) => {
    if (bar(x)) reached.push(i);
    else if (!conds.some((c) => under(c, x, 'margin'))) outliers.push(i);
  });
  return { ok: kept && !reached.length, kept, reached, outliers, medians };
}

// A planted row. Returns { ok, held, below, outliers, medians }: held, the
// median rule; below, indices of samples under the judge's bar on some
// condition; outliers, indices short of the margin on some condition but
// clearing the bar.
export function plantedMargin(samples, conds, clears) {
  const bar = clearsOf(conds, clears);
  const medians = conds.map((c) => median(samples.map((x) => against(c.of(x), c.margin(x)))));
  const held = medians.every((m) => m >= 1);
  const below = [];
  const outliers = [];
  samples.forEach((x, i) => {
    if (!bar(x)) below.push(i);
    else if (!conds.every((c) => over(c, x, 'margin'))) outliers.push(i);
  });
  return { ok: held && !below.length, held, below, outliers, medians };
}
