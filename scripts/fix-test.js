// Every suggested fix is tested (fixtures/PLAN.md, ground rules). For each
// fixture pair, on fresh copies of the planted twin in dist/fix/:
//   - every planted finding carries a fix of the kind defects.json names;
//   - an auto fix is applied (lib/fix.js) and the pair's checks run again:
//     the report must be complete, the finding gone, nothing new reported,
//     and every file the fix edits must still parse;
//   - a guided fix is never applied. Instead each line it lists is replaced
//     by the clean twin's line at the same place, and the checks run again:
//     the finding must be gone and nothing new reported. So the places it
//     lists are enough to fix the defect, and the clean twin is the fix a
//     person would write;
//   - all auto fixes together: only guided findings may be left.
//
// Usage: node scripts/fix-test.js            exit 0 when every fix holds

import { readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES, specOf, copyTwin } from './fixture-test.js';
import { scan } from '../bin/erlang.js';
import { catches } from '../core/fixture-score.js';
import { apply, syntaxErrors } from '../lib/fix.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist', 'fix');

// What changed after a fix in dir: the report partial, the finding still
// there, or anything new.
export function after(dir, f, before, only) {
  const r = scan(dir, { only });
  const was = new Set(before.findings.map((x) => x.fingerprint));
  const now = r.findings.map((x) => x.fingerprint);
  const problems = [];
  if (r.status !== 'complete') problems.push(`the report is ${r.status}: ${r.reason}`);
  if (f && now.includes(f.fingerprint)) problems.push('still reported');
  for (const x of now.filter((y) => !was.has(y))) problems.push(`new: ${x}`);
  return { problems, report: r };
}

// A guided fix carried out as a person would: each listed line replaced by
// the clean twin's line at the same place.
export function followGuided(dir, cleanDir, fix) {
  for (const l of fix.locations) {
    const lines = readFileSync(join(dir, l.file), 'utf8').split('\n');
    const clean = readFileSync(join(cleanDir, l.file), 'utf8').split('\n');
    lines[l.line - 1] = clean[l.line - 1];
    writeFileSync(join(dir, l.file), lines.join('\n'));
  }
}

function main() {
  let failed = 0;
  const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  rmSync(OUT, { recursive: true, force: true });
  for (const id of FIXTURES) {
    const spec = specOf(id);
    const only = spec.checks ?? [spec.check];
    const base = copyTwin(id, 'planted', join(OUT, id, 'base'));
    const cleanDir = join(ROOT, 'fixtures', id, 'clean');
    const before = scan(base, { only });
    console.log(`\n${id}: ${spec.check} (${spec.plan})`);
    for (const d of spec.defects) {
      const f = before.findings.find((x) => catches(x, d));
      if (!f) { ok(`${d.id}: found before any fix`, false); continue; }
      const fix = f.erlang?.fix;
      if (!fix) { ok(`${d.id}: the finding carries a fix`, false); continue; }
      if (d.fix && fix.kind !== d.fix) { ok(`${d.id}: the fix is ${d.fix}`, false, `it is ${fix.kind}`); continue; }
      const dir = join(OUT, id, d.id);
      cpSync(base, dir, { recursive: true });
      let p;
      try {
        if (fix.kind === 'auto') {
          apply(dir, [fix]);
          p = [...new Set(fix.edits.map((e) => e.file))].flatMap((file) => syntaxErrors(file, readFileSync(join(dir, file), 'utf8')).map((at) => `${file}:${at} does not parse after the fix`));
          p.push(...after(dir, f, before, only).problems);
        } else {
          followGuided(dir, cleanDir, fix);
          p = after(dir, f, before, only).problems;
        }
      } catch (e) { p = [e.message]; }
      const label = fix.kind === 'auto' ? `auto, ${fix.edits.length} edit(s): applied, parses, the check no longer reports it, nothing new` : `guided, ${fix.locations.length} place(s): the clean twin's lines there fix it, nothing new`;
      ok(`${d.id}: ${label}`, !p.length, p.join('; '));
    }
    const all = join(OUT, id, 'all');
    cpSync(base, all, { recursive: true });
    const autos = before.findings.filter((f) => f.erlang?.fix?.kind === 'auto');
    const guidedLeft = new Set(before.findings.filter((f) => f.erlang?.fix?.kind === 'guided').map((f) => f.fingerprint));
    try {
      apply(all, autos.map((f) => f.erlang.fix));
      const r = scan(all, { only });
      const left = r.findings.map((f) => f.fingerprint).filter((x) => !guidedLeft.has(x));
      ok(`all ${autos.length} auto fix(es) together: only guided findings are left`, r.status === 'complete' && !left.length, `${r.status}${left.length ? `, left: ${left.join(', ')}` : ''}`);
    } catch (e) {
      ok('all auto fixes together apply', false, e.message);
    }
  }
  // Controls: the test must fail a fix that breaks the code or does not fix
  // the defect, or a pass above means nothing.
  console.log('\ncontrols');
  {
    const id = 'L07-no-timeout';
    const spec = specOf(id);
    const only = spec.checks;
    const base = join(OUT, id, 'base');
    const before = scan(base, { only });
    const autoF = before.findings.find((x) => catches(x, spec.defects.find((d) => d.id === 'L07a')));
    const broken = { ...autoF.erlang.fix, edits: autoF.erlang.fix.edits.map((e) => ({ ...e, replace: e.replace.replace('{', '{ (') })) };
    const dirA = join(OUT, id, 'control-broken');
    cpSync(base, dirA, { recursive: true });
    apply(dirA, [broken]);
    const file = broken.edits[0].file;
    ok('control: an auto fix that leaves a file unparseable is caught', syntaxErrors(file, readFileSync(join(dirA, file), 'utf8')).length > 0);
    const guidedF = before.findings.find((x) => catches(x, spec.defects.find((d) => d.id === 'L07g')));
    const wrong = { ...guidedF.erlang.fix, locations: guidedF.erlang.fix.locations.map((l) => ({ ...l, line: l.line - 1 })) };
    const dirB = join(OUT, id, 'control-wrong-place');
    cpSync(base, dirB, { recursive: true });
    followGuided(dirB, join(ROOT, 'fixtures', id, 'clean'), wrong);
    ok('control: a guided fix that lists the wrong line leaves the finding, and is caught', after(dirB, guidedF, before, only).problems.includes('still reported'));
  }
  console.log(failed ? `\n${failed} fix test(s) failed` : '\nevery suggested fix holds');
  return failed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main() ? 1 : 0);
