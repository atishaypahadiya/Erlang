// Scores a specialist's reports on a pair of fixtures: the planted twin, with
// one documented defect per row, and the clean twin, the same tree with every
// defect fixed. In the manner of ITTEN's scripts/fixture-test.js.
//
// Shared code: it reads only the core of report/1 and finding/1, never a
// specialist's extension, and imports nothing from a specialist.
//
// spec:
//   defects: [{ id, check, where, severity?, title? }]
//   decoys:  [{ id, where, title? }]   in both twins; reporting one is a
//            false positive, named by the decoy's id.
//   where is { file, line?, column?, symbol? }, or a list of them when the
//   finding must name several places (a place in built output and the
//   original source a source map leads back to).
//
// A finding catches a defect when its check is the defect's, its
// where.locations name every place the defect lists (file, and line, column
// and symbol where given), and its severity is the defect's, where given.
// Precision counts every finding on the clean twin, and every finding on the
// planted twin that catches no defect, as a false positive.

const at = (loc, w) => loc.file === w.file
  && (w.line === undefined || loc.line === w.line)
  && (w.column === undefined || loc.column === w.column)
  && (w.symbol === undefined || loc.symbol === w.symbol);
const names = (f, where) => [where].flat().every((w) => (f.where?.locations ?? []).some((loc) => at(loc, w)));
export const catches = (f, d) => f.check === d.check && names(f, d.where) && (!d.severity || f.severity === d.severity);

// A report that did not run every check cannot vouch for a clean result.
function usable(r, name) {
  if (r?.schema !== 'report/1') throw new Error(`${name}: not a report/1`);
  if (r.status !== 'complete') throw new Error(`${name}: the run is ${r.status} (${r.reason ?? 'no reason given'}); only a complete run can be scored`);
  return r.findings;
}

export function score(spec, { planted, clean }) {
  const onPlanted = usable(planted, 'planted twin');
  const onClean = usable(clean, 'clean twin');
  const rows = spec.defects.map((d) => {
    const hits = onPlanted.filter((f) => catches(f, d));
    return { id: d.id, check: d.check, title: d.title, caught: hits.length > 0, findings: hits.map((f) => f.fingerprint) };
  });
  const truePositives = onPlanted.filter((f) => spec.defects.some((d) => catches(f, d)));
  const decoyOf = (f) => (spec.decoys ?? []).find((x) => names(f, x.where))?.id ?? null;
  const falsePositives = [
    ...onPlanted.filter((f) => !spec.defects.some((d) => catches(f, d))).map((f) => ({ twin: 'planted', f })),
    ...onClean.map((f) => ({ twin: 'clean', f })),
  ].map(({ twin, f }) => ({ twin, check: f.check, severity: f.severity, fingerprint: f.fingerprint, message: f.message, decoy: decoyOf(f) }));
  const caught = rows.filter((r) => r.caught).length;
  return {
    defects: rows.length,
    caught,
    missed: rows.filter((r) => !r.caught).map((r) => r.id),
    recall: rows.length ? caught / rows.length : 1,
    findingsOnPlanted: onPlanted.length,
    findingsOnClean: onClean.length,
    truePositives: truePositives.length,
    precision: truePositives.length / (truePositives.length + falsePositives.length || 1),
    decoys: (spec.decoys ?? []).length,
    decoysReported: [...new Set(falsePositives.map((x) => x.decoy).filter(Boolean))],
    rows,
    falsePositives,
  };
}

export const passed = (r) => r.recall === 1 && r.falsePositives.length === 0;

// The result as lines for a terminal.
export function format(r) {
  const out = r.rows.map((row) => `${row.caught ? 'caught' : 'MISSED'}  ${row.id.padEnd(6)} ${row.check.padEnd(22)} ${row.title ?? ''}`);
  for (const fp of r.falsePositives) out.push(`false positive (${fp.twin}${fp.decoy ? `, decoy ${fp.decoy}` : ''})  ${fp.fingerprint}  ${fp.message}`);
  out.push('', `Caught ${r.caught}/${r.defects} planted (recall ${r.recall.toFixed(2)}). Precision ${r.truePositives}/${r.truePositives + r.falsePositives.length} = ${r.precision.toFixed(2)}. Clean twin: ${r.findingsOnClean} findings. Decoys reported: ${r.decoysReported.length}/${r.decoys}.`);
  return out;
}
