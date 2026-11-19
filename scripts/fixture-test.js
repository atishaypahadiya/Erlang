// Runs ERLANG on each fixture pair and scores the reports with the shared
// core's scorer (core/fixture-score.js): every planted defect must be
// caught, and nothing else reported on either twin, decoys included. Each
// check publishes its own recall and precision (fixtures/PLAN.md).
//
//   1. Each fixtures/<id>/defects.json is read; the twins must differ only in
//      files that hold a planted defect.
//   2. Both twins are copied to dist/fixtures/<id>/work/<twin> and scanned
//      with the pair's checks alone; nothing is installed or run.
//   3. Each report/1 is validated, with every finding's erlang extension
//      (schema/finding-erlang.schema.json), and written to
//      dist/fixtures/<id>/<twin>/report.json.
//   4. The pair is scored; every result goes to dist/fixtures/result.json.
//
// Expected rows (spec.expected: [{ id, check, where, title }]) name a finding
// that is right on both twins, such as an info finding ERLANG cannot decide.
// It must be reported on both twins, as info, and counts neither as a catch
// nor as a false positive: it is set aside before the shared scorer
// (core/fixture-score.js, which knows nothing of expected rows) sees the
// reports. Every clean twin must also exit 0 by the CLI's rule (bin/erlang.js,
// exitCode): no error or warning, and a complete run.
//
// Usage: node scripts/fixture-test.js      exit 0 only when everything passes

import { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, exitCode } from '../bin/erlang.js';
import { write, check } from '../core/report.js';
import { validate } from '../core/schema.js';
import { score, format, passed, catches } from '../core/fixture-score.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist', 'fixtures');
const extensionSchema = JSON.parse(readFileSync(join(ROOT, 'schema', 'finding-erlang.schema.json'), 'utf8'));

// Every fixture pair: a directory under fixtures/ with a defects.json, or,
// for a fixture with forms (raw SQL and Prisma), each form's directory one
// level down: L01a-n-plus-one/sql.
const dirs = (rel) => readdirSync(join(ROOT, 'fixtures', rel), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => (rel ? `${rel}/${e.name}` : e.name));
const hasSpec = (rel) => existsSync(join(ROOT, 'fixtures', rel, 'defects.json'));
export const FIXTURES = dirs('')
  .flatMap((d) => (hasSpec(d) ? [d] : dirs(d).filter(hasSpec)))
  .sort();

export const specOf = (id) => JSON.parse(readFileSync(join(ROOT, 'fixtures', id, 'defects.json'), 'utf8'));

// A fresh copy of a twin, at to (default dist/fixtures/<id>/work/<twin>).
export function copyTwin(id, twin, to = join(OUT, id, 'work', twin)) {
  rmSync(to, { recursive: true, force: true });
  cpSync(join(ROOT, 'fixtures', id, twin), to, { recursive: true });
  return to;
}

const filesOf = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
  .sort();

// Files that differ between the twins and hold no planted defect. A defect
// may name files its fix adds in the clean twin (fixedIn: a new migration).
function strayDifferences(id, spec) {
  const planted = join(ROOT, 'fixtures', id, 'planted');
  const clean = join(ROOT, 'fixtures', id, 'clean');
  const planting = new Set(spec.defects.flatMap((d) => [...[d.where].flat().map((w) => w.file), ...(d.fixedIn ?? [])]));
  const all = [...new Set([...filesOf(planted), ...filesOf(clean)])];
  return all.filter((f) => {
    const a = existsSync(join(planted, f)) ? readFileSync(join(planted, f), 'utf8') : null;
    const b = existsSync(join(clean, f)) ? readFileSync(join(clean, f), 'utf8') : null;
    return a !== b && !planting.has(f);
  }).map((f) => `${id}: ${f} differs between the twins but holds no planted defect`);
}

export function problemsOf(r, label) {
  const out = check(r).map((e) => `${label}: report/1: ${e}`);
  for (const f of r.findings) {
    if (!f.erlang) out.push(`${label}: ${f.fingerprint}: no erlang extension`);
    else out.push(...validate(extensionSchema, f.erlang).map((e) => `${label}: ${f.fingerprint}: erlang extension: ${e}`));
  }
  return out;
}

// Sets aside the findings expected rows name. Returns the reports the scorer
// sees, what was set aside, and any problem: an expected row missing from a
// twin, or reported at a severity other than info.
export function applyExpected(spec, reports) {
  const rows = spec.expected ?? [];
  const problems = [];
  const matches = (f) => rows.find((x) => catches(f, { check: x.check, where: x.where }));
  const kept = {};
  const setAside = [];
  for (const [twin, r] of Object.entries(reports)) {
    kept[twin] = { ...r, findings: r.findings.filter((f) => !matches(f)) };
    for (const x of rows) {
      const hits = r.findings.filter((f) => catches(f, { check: x.check, where: x.where }));
      if (!hits.length) problems.push(`expected ${x.id} is not reported on the ${twin} twin`);
      for (const f of hits) {
        if (f.severity !== 'info') problems.push(`expected ${x.id} is reported as ${f.severity} on the ${twin} twin; an expected row must be info`);
        setAside.push({ id: x.id, twin, fingerprint: f.fingerprint });
      }
    }
  }
  return { reports: kept, setAside, problems };
}

function runFixture(id) {
  const spec = specOf(id);
  const reports = {};
  const problems = strayDifferences(id, spec);
  for (const twin of ['planted', 'clean']) {
    copyTwin(id, twin);
    const prev = process.cwd();
    process.chdir(join(OUT, id, 'work'));
    try { reports[twin] = scan(twin, { only: spec.checks ?? [spec.check] }); } finally { process.chdir(prev); }
    write(join(OUT, id, twin, 'report.json'), reports[twin]);
    problems.push(...problemsOf(reports[twin], `${id}/${twin}`));
  }
  if (exitCode(reports.clean) !== 0) problems.push(`${id}/clean: the clean twin would exit ${exitCode(reports.clean)}, not 0`);
  const ex = applyExpected(spec, reports);
  problems.push(...ex.problems.map((p) => `${id}: ${p}`));
  return { fixture: id, check: spec.check, plan: spec.form ? `${spec.plan}, ${spec.form}` : spec.plan, ...score(spec, ex.reports), expected: ex.setAside, problems };
}

export function run() {
  const fixtures = FIXTURES.map(runFixture);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'result.json'), JSON.stringify({ fixtures }, null, 2) + '\n');
  return fixtures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let ok = FIXTURES.length > 0;
  for (const c of run()) {
    console.log(`\n${c.fixture}: ${c.check} (${c.plan})`);
    for (const line of format(c)) console.log(`  ${line}`);
    for (const id of [...new Set(c.expected.map((e) => e.id))]) console.log(`  expected ${id}: info on both twins, set aside`);
    for (const p of c.problems) console.log(`  problem: ${p}`);
    ok = ok && passed(c) && !c.problems.length;
  }
  console.log(`\nReports: dist/fixtures/<fixture>/<twin>/report.json; result: dist/fixtures/result.json\n${ok ? 'every fixture passes' : 'FAILED'}`);
  process.exit(ok ? 0 : 1);
}
