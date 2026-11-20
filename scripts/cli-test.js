// The CLI end to end: each documented invocation of bin/erlang.js run as a
// child process, checking its exit code, where the report is written and
// what it says. Subjects are copies of the L07 fixture twins in dist/cli/.
//
//   erlang <dir>                 report to dist/reports/<dir name>/
//   erlang <dir> --out <file>    report to <file>
//   erlang --out <file> <dir>    the same, flag first
//   erlang --version
// Exit codes: 0 complete with no failing findings, 1 failing findings (error
// or warning; info never fails), 2 refused, 3 partial with no failing
// findings, 64 bad usage, 70 an internal failure.
//
// Usage: node scripts/cli-test.js            exit 0 when every case holds

import { spawnSync, execFileSync } from 'node:child_process';
import { VERSION, commit, uncommitted } from '../bin/erlang.js';
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
  ok('<dir>: the last line says complete and where the report is', /^complete: 0 failing \(0 error, 0 warning\), 0 info\. Report: dist\/reports\/cli-clean\/report\.json$/.test(r.stdout.trim().split('\n').at(-1)), r.stdout.trim().split('\n').at(-1));
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
  // A pool checkout never released, with no request handler: info only.
  const dir = join(OUT, 'cli-info');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.js'), "import pg from 'pg';\nconst pool = new pg.Pool({ statement_timeout: 5000, connectionTimeoutMillis: 2000 });\nexport async function run() {\n  const c = await pool.connect();\n  await c.query('select 1');\n}\n");
  const at = join(OUT, 'info.json');
  const r = cli(dir, '--out', at);
  const rep = json(at);
  const last = r.stdout.trim().split('\n').at(-1);
  ok('<dir>: info findings only exit 0, and the summary counts info apart', r.status === 0 && rep?.findings.length > 0 && rep.findings.every((f) => f.severity === 'info') && /^complete: 0 failing \(0 error, 0 warning\), \d+ info\./.test(last), `exit ${r.status}; ${last}`);
  writeFileSync(join(dir, 'broken.js'), Buffer.from([0x66, 0x28, 0xff, 0x29, 0x0a]));
  const r2 = cli(dir, '--out', at);
  ok('<dir>: partial with info findings only exits 3', r2.status === 3 && json(at)?.status === 'partial', `exit ${r2.status}`);
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
  // commit() on hand-made .git layouts: packed refs, a worktree's .git file,
  // a detached HEAD, and no checkout at all.
  const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
  const g = (p, text) => { mkdirSync(dirname(join(OUT, 'git', p)), { recursive: true }); writeFileSync(join(OUT, 'git', p), text); };
  rmSync(join(OUT, 'git'), { recursive: true, force: true });
  g('packed/.git/HEAD', 'ref: refs/heads/main\n'); g('packed/.git/packed-refs', `# pack-refs with: peeled\n${B} refs/heads/mainline\n${A} refs/heads/main\n`);
  g('main/.git/HEAD', 'ref: refs/heads/main\n'); g('main/.git/refs/heads/main', `${A}\n`);
  g('main/.git/worktrees/wt/HEAD', 'ref: refs/heads/side\n'); g('main/.git/worktrees/wt/commondir', '../..\n'); g('main/.git/refs/heads/side', `${B}\n`);
  g('wt/.git', `gitdir: ${join(OUT, 'git', 'main', '.git', 'worktrees', 'wt')}\n`);
  g('detached/.git/HEAD', `${C}\n`);
  g('none/x', '');
  g('escape/.git/HEAD', 'ref: refs/../../HEAD\n');
  const got = ['packed', 'main', 'wt', 'detached', 'none', 'escape'].map((d) => commit(join(OUT, 'git', d)));
  ok('commit(): packed ref, loose ref, worktree, detached, no checkout, a ref that leaves .git', JSON.stringify(got) === JSON.stringify([A, A, B, C, null, null]), JSON.stringify(got.map((x) => x && x[0])));
  // uncommitted() on a scratch repository: clean, an untracked file, an
  // unstaged edit, a staged edit, and a directory git cannot read (a
  // directory inside this checkout would answer for this checkout).
  const repo = join(OUT, 'git', 'repo');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', repo, ...a], { stdio: 'ignore' });
  mkdirSync(repo, { recursive: true });
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'one');
  const states = [uncommitted(repo)];
  writeFileSync(join(repo, 'new.txt'), 'untracked\n');
  states.push(uncommitted(repo));
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  states.push(uncommitted(repo));
  git('add', 'a.txt');
  states.push(uncommitted(repo));
  states.push(uncommitted(join(OUT, 'git', 'does-not-exist')));
  ok('uncommitted(): clean, untracked only, unstaged edit, staged edit, and null where git cannot say', JSON.stringify(states) === JSON.stringify([false, false, true, true, null]), JSON.stringify(states));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirty = spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: ROOT }).status === 1;
  ok(`--version: the version, the commit (as git names HEAD)${dirty ? ', and (uncommitted changes), since this checkout has some' : ', no suffix, since this checkout is clean'}; not the Erlang runtime; exit 0`, r.status === 0 && r.stdout.trim() === `erlang ${VERSION} (commit ${head}): load and resilience checks (not the Erlang runtime)${dirty ? ' (uncommitted changes)' : ''}`, r.stdout.trim());
}
for (const [label, args] of [['no arguments', []], ['--out with no file', [clean, '--out']], ['--out alone', ['--out', join(OUT, 'x.json')]], ['an unknown flag', [clean, '--fast']]]) {
  const r = cli(...args);
  ok(`bad usage (${label}): exit 64 and the usage line, nothing written`, r.status === 64 && /^usage: /.test(r.stderr) && !existsSync(join(OUT, 'x.json')), `exit ${r.status}`);
}
{
  // An internal failure: the report cannot be written, since --out passes
  // through a file. A crash exits 70, not 1 (failing findings).
  const r = cli(clean, '--out', join(ROOT, 'package.json', 'x', 'report.json'));
  ok('an internal failure (the report cannot be written): exit 70, and stderr says internal failure', r.status === 70 && /^erlang: internal failure \(exit 70\): /.test(r.stderr), `exit ${r.status}, ${r.stderr.trim().split('\n')[0]}`);
}

console.log(failed ? `\n${failed} CLI case(s) failed` : '\nevery documented invocation behaves');
process.exit(failed ? 1 : 0);
