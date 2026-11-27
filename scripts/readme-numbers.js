// Checks the numbers that README.md and docs/explanation.md mark as checked.
// A marked number is written
//   <!--n:key-->value<!--/n-->
// and each key has one source in the tree, below. The test fails when a marked
// value differs from what its source gives now, when a marker names a key with
// no source, or when the coverage counts stop adding up to the planted total.
//
// Two kinds of source:
//   derived   counted or read from the files the number is about;
//   recorded  matched against the sentence in CHANGELOG.md that records it,
//             for numbers that come from CI run artifacts, which are not in
//             the tree (the trace and load coverage counts, two medians);
//             or read from docs/evidence/, which records a run on a project
//             outside the tree.
//
// Usage: node scripts/readme-numbers.js [--root <dir>] [--readme <file> ...]
//        exit 0 when every marked number matches its source

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : resolve(args[i + 1]); };
const ROOT = opt('--root', join(dirname(fileURLToPath(import.meta.url)), '..'));
const given = args.flatMap((a, i) => (args[i - 1] === '--readme' ? [resolve(a)] : []));
const PAGES = given.length ? given : ['README.md', 'docs/explanation.md'].map((p) => join(ROOT, p));
const text = (p) => readFileSync(join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(text(p));

// Every file of one name under fixtures/.
function named(name, dir = 'fixtures', out = []) {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== 'node_modules') named(name, p, out); } else if (e.name === name) out.push(p);
  }
  return out.sort();
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
function match(file, re) {
  const m = text(file).match(re);
  if (!m) throw new Error(`${file} no longer holds the text a number is matched against: ${re}`);
  return m;
}

const defectFiles = named('defects.json').map(json);
const traceForms = named('trace.json').map(json);
const loadFormPaths = named('load.json');
const loadForms = loadFormPaths.map(json);
const planted = sum(defectFiles.map((d) => d.defects.length));
const traceMisses = sum(traceForms.map((t) => (t.expectedMisses ?? []).length));
const loadMisses = sum(loadForms.map((l) => (l.expectedMisses ?? []).length));

const { CHECKS } = await import(pathToFileURL(join(ROOT, 'lib/erlang.js')).href);
const checkNames = CHECKS.flatMap((c) => c.CHECKS ?? [c.CHECK]);

// The sentence in CHANGELOG.md that records the coverage per mode.
const cov = match('CHANGELOG.md', /which plant (\d+) defects: the static checks find all (\d+); the trace finds (\d+), with (\d+) documented expected misses? and (\d+) it does not exercise; the load forms find (\d+), with (\d+) documented expected miss(?:es)? and (\d+) they do not exercise/).slice(1).map(Number);
const [cPlanted, cStatic, cTrace, cTraceMiss, cTraceNone, cLoad, cLoadMiss, cLoadNone] = cov;

const problems = [];
const must = (ok, msg) => { if (!ok) problems.push(msg); };
must(cPlanted === planted, `CHANGELOG.md says ${cPlanted} planted defects; the defects files hold ${planted}`);
must(cStatic === planted, `CHANGELOG.md says the static checks find ${cStatic}; ${planted} are planted`);
must(cTraceMiss === traceMisses, `CHANGELOG.md says ${cTraceMiss} trace expected misses; the trace forms list ${traceMisses}`);
must(cLoadMiss === loadMisses, `CHANGELOG.md says ${cLoadMiss} load expected miss(es); the load forms list ${loadMisses}`);
must(cTrace + cTraceMiss + cTraceNone === planted, `trace: ${cTrace} + ${cTraceMiss} + ${cTraceNone} is not ${planted}`);
must(cLoad + cLoadMiss + cLoadNone === planted, `load: ${cLoad} + ${cLoadMiss} + ${cLoadNone} is not ${planted}`);

const ci = text('.github/workflows/ci.yml');
const jobs = [...ci.slice(ci.indexOf('\njobs:')).matchAll(/^ {2}([a-z][a-z-]*):\s*$/gm)].map((m) => m[1]);
// The load job is a matrix of every load form but L05, which load-long runs.
const matrix = loadFormPaths.filter((p) => !p.startsWith('fixtures/L05-memory-growth/')).length;
must(jobs.includes('load') && jobs.includes('load-long'), 'ci.yml no longer has the load and load-long jobs the job count assumes');
const ruleIds = new Set(readdirSync(join(ROOT, 'reference/rules')).flatMap((f) => text(`reference/rules/${f}`).match(/\b[A-Z]{3}-\d{2}\b/g) ?? []));
const umami = json('docs/evidence/umami.json');
const runsIn = (w) => umami.findings.filter((x) => x.severity === 'error' && x.runsIn === w).length;
const signup = match('CHANGELOG.md', /median ([\d.]+) ms on the Mac under macOS 27\.2 and ([\d.]+) ms under macOS 27\.3/);

// key -> [value now, source]
const SOURCES = {
  version: [json('package.json').version, 'package.json, version'],
  node: [json('package.json').engines.node.replace(/^>=/, ''), 'package.json, engines.node'],
  typescript: [json('package.json').dependencies.typescript, 'package.json, dependencies'],
  k6: [match('.github/workflows/ci.yml', /Install k6 (v[\d.]+)/)[1], '.github/workflows/ci.yml, the k6 install step'],
  checks: [checkNames.length, 'lib/erlang.js, CHECKS'],
  rules: [ruleIds.size, 'reference/rules/, distinct rule ids'],
  'rule-files': [readdirSync(join(ROOT, 'reference/rules')).length, 'reference/rules/, files'],
  classes: [readdirSync(join(ROOT, 'fixtures'), { withFileTypes: true }).filter((e) => e.isDirectory() && /^L\d/.test(e.name)).length, 'fixtures/, folders named L*'],
  pairs: [defectFiles.length, 'fixtures/**/defects.json, files'],
  planted: [planted, 'fixtures/**/defects.json, defects'],
  decoys: [sum(defectFiles.map((d) => (d.decoys ?? []).length)), 'fixtures/**/defects.json, decoys'],
  'trace-forms': [traceForms.length, 'fixtures/**/trace/trace.json, files'],
  'trace-reports': [traceForms.length * 2, 'two twins for each trace form'],
  'load-forms': [loadForms.length, 'fixtures/**/load/load.json, files'],
  'static-found': [planted, 'fixtures/**/defects.json; scripts/fixture-test.js fails on any planted defect not caught'],
  'trace-found': [cTrace, 'CHANGELOG.md, the opening sentence (recorded)'],
  'trace-misses': [traceMisses, 'fixtures/**/trace/trace.json, expectedMisses'],
  'trace-none': [cTraceNone, 'CHANGELOG.md, the opening sentence (recorded)'],
  'load-found': [cLoad, 'CHANGELOG.md, the opening sentence (recorded)'],
  'load-misses': [loadMisses, 'fixtures/**/load/load.json, expectedMisses'],
  'load-none': [cLoadNone, 'CHANGELOG.md, the opening sentence (recorded)'],
  'gate-runs': [match('scripts/release-gate.sh', /^RUNS=(\d+)$/m)[1], 'scripts/release-gate.sh, RUNS'],
  repeats: [match('lib/timing.js', /export const MIN_REPEATS = (\d+);/)[1], 'lib/timing.js, MIN_REPEATS'],
  'headroom-max': [match('scripts/headroom/judge.js', /export const HEADROOM_MAX = ([\d.]+);/)[1], 'scripts/headroom/judge.js, HEADROOM_MAX'],
  'headroom-one': [match('scripts/headroom/judge.js', /export const HEADROOM_ONE = ([\d.]+);/)[1], 'scripts/headroom/judge.js, HEADROOM_ONE'],
  'ci-jobs': [jobs.length - 1 + matrix, '.github/workflows/ci.yml jobs, with the load matrix counted per load form but L05'],
  'signup-27.2': [signup[1], 'CHANGELOG.md, thin margins, L09 trace (recorded)'],
  'signup-27.3': [signup[2], 'CHANGELOG.md, thin margins, L09 trace (recorded)'],
  'umami-files': [umami.files, 'docs/evidence/umami.json, files'],
  'umami-handlers': [umami.handlers, 'docs/evidence/umami.json, handlers'],
  'umami-seconds': [umami.seconds, 'docs/evidence/umami.json, seconds'],
  'umami-errors': [umami.findings.filter((x) => x.severity === 'error').length, 'docs/evidence/umami.json, findings that are errors'],
  'umami-infos': [umami.findings.filter((x) => x.severity === 'info').length, 'docs/evidence/umami.json, findings that are info'],
  'umami-scripts': [runsIn('build or maintenance script'), 'docs/evidence/umami.json, errors in scripts'],
  'umami-tests': [runsIn('test'), 'docs/evidence/umami.json, errors in tests'],
  'umami-browser': [runsIn('browser'), 'docs/evidence/umami.json, errors in browser code'],
  'umami-server': [runsIn('server'), 'docs/evidence/umami.json, errors in server code'],
};

const marks = [];
for (const page of PAGES) {
  const text = readFileSync(page, 'utf8');
  const found = [...text.matchAll(/<!--n:([a-z0-9.-]+)-->([^<]*)<!--\/n-->/g)];
  must((text.match(/<!--n:/g) ?? []).length === found.length, `${page}: a number marker is malformed (an opening <!--n:key--> with no value and <!--/n--> after it)`);
  marks.push(...found);
}
must(marks.length > 0, 'no page marks a number');
const used = new Set();
for (const [, key, value] of marks) {
  used.add(key);
  if (!(key in SOURCES)) { problems.push(`marker ${key}: no source is defined for this key`); continue; }
  const [now, source] = SOURCES[key];
  must(String(now) === value.trim().replace(/,/g, ''), `marker ${key}: README says ${value.trim()}, its source gives ${now} (${source})`);
}

if (problems.length) {
  for (const p of problems) console.log(`FAIL  ${p}`);
  console.log(`readme-numbers: ${problems.length} problem(s) in ${marks.length} marked number(s)`);
  process.exit(1);
}
console.log(`readme-numbers: ${marks.length} marked number(s) under ${used.size} key(s) in ${PAGES.length} page(s) match their sources`);
