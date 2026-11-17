// The CLI end to end: each documented invocation of bin/erlang.js run as a
// child process, checking its exit code, where the report is written and
// what it says. Subjects are copies of the L07 fixture twins in dist/cli/.
//
//   erlang <dir>                 report to dist/reports/<dir name>/
//   erlang <dir> --out <file>    report to <file>
//   erlang --out <file> <dir>    the same, flag first
//   erlang --version
// Exit codes: 0 complete and clean, 1 findings, 2 refused, 3 partial with no
// findings, 64 bad usage.
//
// Usage: node scripts/cli-test.js            exit 0 when every case holds

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist', 'cli');
const BIN = join(ROOT, 'bin', 'erlang.js');
let failed = 0;
const ok = (name, cond, detail = '') => { if (!cond) failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8' });
const json = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const twin = (name, to) => { const dir = join(OUT, to); cpSync(join(ROOT, 'fixtures', 'L07-no-timeout', name), dir, { recursive: true }); return dir; };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const clean = twin('clean', 'cli-clean');
const planted = twin('planted', 'cli-planted');
const partial = twin('clean', 'cli-partial');
writeFileSync(join(partial, 'src', 'broken.js'), Buffer.from([0x66, 0x65, 0x74, 0x63, 0x68, 0x28, 0xff, 0xfe, 0x29, 0x0a]));
const refusedConfig = twin('clean', 'cli-bad-config');
writeFileSync(join(refusedConfig, 'erlang.config.json'), '{ "exclude": ["../outside"] }\n');

{
  const at = join(ROOT, 'dist', 'reports', 'cli-clean', 'report.json');
  rmSync(at, { force: true });
  const r = cli(clean);
  const rep = json(at);
  ok('<dir>: a clean subject exits 0 and writes dist/reports/<dir name>/report.json', r.status === 0 && rep?.status === 'complete' && rep.findings.length === 0, `exit ${r.status}${r.stderr ? `, ${r.stderr.trim().split('\n')[0]}` : ''}`);
  ok('<dir>: the last line says complete and where the report is', /^complete: 0 finding\(s\)\. Report: dist\/reports\/cli-clean\/report\.json$/.test(r.stdout.trim().split('\n').at(-1)), r.stdout.trim().split('\n').at(-1));
  ok('<dir>: the report names the scope config and what it excludes', rep?.erlang?.scope?.config === 'erlang.config.json' && rep.erlang.scope.exclude.includes('scripts'));
}
{
  const at = join(OUT, 'out-after.json');
  const r = cli(planted, '--out', at);
  const rep = json(at);
  ok('<dir> --out <file>: findings exit 1, and the report is written to <file>', r.status === 1 && rep?.findings.length > 0 && rep.status === 'complete', `exit ${r.status}`);
  ok('<dir> --out <file>: one line per finding, then the summary', r.stdout.trim().split('\n').length === rep.findings.length + 1);
  ok('<dir>: the report carries no absolute path', !JSON.stringify(rep).includes(ROOT));
}
{
  const at = join(OUT, 'out-before.json');
  const r = cli('--out', at, planted);
  ok('--out <file> <dir>: the flag may come first', r.status === 1 && json(at)?.findings.length > 0, `exit ${r.status}`);
}
{
  const at = join(OUT, 'partial.json');
  const r = cli(partial, '--out', at);
  const rep = json(at);
  ok('<dir>: a file that is not UTF-8, and no findings, exits 3 with the file named', r.status === 3 && rep?.status === 'partial' && rep.reason.includes('src/broken.js: not read'), `exit ${r.status}, ${rep?.reason}`);
}
{
  const at = join(OUT, 'refused.json');
  const r = cli(join(OUT, 'no-such-dir'), '--out', at);
  const rep = json(at);
  ok('<dir> that does not exist: refused, exit 2, and the refusal is written', r.status === 2 && rep?.status === 'refused' && rep.findings.length === 0 && !rep.reason.includes(ROOT), `exit ${r.status}`);
}
{
  const at = join(OUT, 'bad-config.json');
  const r = cli(refusedConfig, '--out', at);
  const rep = json(at);
  ok('<dir> whose erlang.config.json breaks its schema: refused, exit 2', r.status === 2 && rep?.status === 'refused' && rep.reason.includes('erlang.config.json'), `exit ${r.status}`);
}
{
  const r = cli('--version');
  ok('--version: says what it is and that it is not the Erlang runtime, exit 0', r.status === 0 && /^erlang \d+\.\d+\.\d+: load and resilience checks \(not the Erlang runtime\)$/.test(r.stdout.trim()), r.stdout.trim());
}
for (const [label, args] of [['no arguments', []], ['--out with no file', [clean, '--out']], ['--out alone', ['--out', join(OUT, 'x.json')]], ['an unknown flag', [clean, '--fast']]]) {
  const r = cli(...args);
  ok(`bad usage (${label}): exit 64 and the usage line, nothing written`, r.status === 64 && /^usage: /.test(r.stderr) && !existsSync(join(OUT, 'x.json')), `exit ${r.status}`);
}

console.log(failed ? `\n${failed} CLI case(s) failed` : '\nevery documented invocation behaves');
process.exit(failed ? 1 : 0);
