// Unit cases for what the L07 fixture does not cover: other ways of
// importing and configuring each client, the shapes a fix must handle, and
// controls for per-file isolation; and for n-plus-one and per-row-writes,
// the handlers and shapes the L01 fixtures do not cover. Each case writes a
// small subject to dist/unit/<case>/ and scans it with the checks it is
// about (no-timeout unless it says otherwise).
//
// Usage: node scripts/unit-test.js           exit 0 when every case holds

import { writeFileSync, mkdirSync, rmSync, readFileSync, cpSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scan } from '../lib/erlang.js';
import { apply, syntaxErrors, fileOf } from '../lib/fix.js';
import { describe, Plain } from '../lib/isolate.js';
import * as TJ from '../lib/trace-judge.js';
import * as TIMING from '../lib/timing.js';
const { declaredWaits } = TIMING;
import * as LOCK from '../lib/itten-lock.js';
import * as GUARD from '../lib/load-guard.js';
import { warmupFor, FALLBACK_WARMUP } from '../lib/scope.js';
import { scenario } from '../lib/k6-scenario.js';
import { scenario as k6Scenario } from '../lib/k6-scenario.js';
import { applyExpected } from './fixture-test.js';
import { score } from '../core/fixture-score.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist', 'unit');
let failed = 0;
const ok = (name, cond, detail = '') => { if (!cond) failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

rmSync(OUT, { recursive: true, force: true });
let n = 0;
function subject(files) {
  const dir = join(OUT, String(++n).padStart(2, '0'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const scanOf = (dir, only = ['no-timeout']) => scan(dir, { only });
const summary = (r) => r.findings.map((f) => `${f.severity} ${f.where.locations[0].file}:${f.where.locations[0].line} ${f.erlang.fix.kind}`).join('; ') || 'none';

// expect: a list of [severity, file, line, fix kind] in report order, or [].
function expectFindings(name, files, expect, only) {
  const r = scanOf(subject(files), only);
  const got = r.findings.map((f) => [f.severity, f.where.locations[0].file, f.where.locations[0].line, f.erlang.fix.kind]);
  ok(name, r.status === 'complete' && JSON.stringify(got) === JSON.stringify(expect), `${r.status}; got ${summary(r)}`);
  return r;
}

// An auto fix must apply, parse, and leave nothing reported.
function expectAutoFixHolds(name, files, only) {
  const dir = subject(files);
  const before = scanOf(dir, only);
  const f = before.findings[0];
  if (!f || f.erlang.fix.kind !== 'auto') { ok(name, false, `no auto fix: ${summary(before)}`); return; }
  const fixed = `${dir}-fixed`;
  cpSync(dir, fixed, { recursive: true });
  apply(fixed, [f.erlang.fix]);
  const file = fileOf(f.erlang.fix.edits[0]);
  const text = readFileSync(join(fixed, file), 'utf8');
  const after = scanOf(fixed, only);
  ok(name, !syntaxErrors(file, text).length && after.status === 'complete' && after.findings.length === 0, `${text.trim().split('\n').find((l) => /timeout|signal|Many\(/.test(l))?.trim()}; after: ${summary(after)}`);
}

console.log('Clients and how they are imported');
expectFindings('CommonJS require of axios: axios.get with no timeout is an error', {
  'a.js': "const axios = require('axios');\nmodule.exports = (u) => axios.get(u);\n",
}, [['error', 'a.js', 2, 'auto']]);
expectFindings('A named import of Pool from pg, with no config: an error with an auto fix', {
  'db.js': "import { Pool } from 'pg';\nexport const pool = new Pool();\n",
}, [['error', 'db.js', 2, 'auto']]);
expectFindings('fetch imported from undici is checked like the global', {
  'u.js': "import { fetch } from 'undici';\nexport const f = (u) => fetch(u);\n",
}, [['error', 'u.js', 2, 'auto']]);
expectFindings('A function named fetch imported from the project is not a network call', {
  'my.js': 'export function fetch(k) { return k; }\n',
  'use.js': "import { fetch } from './my.js';\nexport const g = () => fetch('k');\n",
}, []);
expectFindings('fetch(new Request(url, { signal: AbortSignal.timeout(ms) })) is bounded', {
  'r.js': 'export const f = (u) => fetch(new Request(u, { signal: AbortSignal.timeout(1000) }));\n',
}, []);
expectFindings('An options object declared elsewhere in the module, with a signal, is followed', {
  'o.js': 'const opts = { signal: AbortSignal.timeout(1000) };\nexport const f = (u) => fetch(u, opts);\n',
}, []);
expectFindings('An options object changed after it is declared cannot be judged: info', {
  'm.js': 'export function f(u, s) {\n  const opts = {};\n  opts.signal = s;\n  return fetch(u, opts);\n}\n',
}, [['info', 'm.js', 4, 'guided']]);

console.log('\nDefaults and instances');
expectFindings('axios.defaults.timeout set anywhere bounds the default instance', {
  'setup.js': "import axios from 'axios';\naxios.defaults.timeout = 5000;\n",
  'use.js': "import axios from 'axios';\nexport const f = (u) => axios.get(u);\n",
}, []);
expectFindings('instance.defaults.timeout bounds that instance', {
  'c.js': "import axios from 'axios';\nexport const api = axios.create({ baseURL: 'x' });\napi.defaults.timeout = 2000;\nexport const f = () => api.get('/y');\n",
}, []);
expectFindings('An explicit timeout: 0 on axios is no timeout; the fix is guided, not an edit over the owner\'s value', {
  'z.js': "import axios from 'axios';\nexport const f = (u) => axios.get(u, { timeout: 0 });\n",
}, [['error', 'z.js', 2, 'guided']]);
expectFindings('A got instance extended from one with a request timeout is bounded', {
  'g.js': "import got from 'got';\nconst a = got.extend({ timeout: { request: 1000 } });\nconst b = a.extend({ prefixUrl: 'x' });\nexport const f = () => b.get('y');\n",
}, []);
expectFindings('An axios instance no call uses is not reported', {
  'i.js': "import axios from 'axios';\nexport const unused = axios.create({ baseURL: 'x' });\n",
}, []);

console.log('\nnode:http, and fetch inside helpers');
expectFindings('http.request with req.setTimeout on the request is bounded', {
  'h.js': "import http from 'node:http';\nexport function f(u) {\n  const req = http.request(u);\n  req.setTimeout(1000, () => req.destroy());\n  return req;\n}\n",
}, []);
expectFindings('req.setTimeout(ms) with no callback and no handler only emits an event: a warning, auto-fixed', {
  'h.js': "import https from 'node:https';\nexport function f(url) {\n  const req = https.get(url);\n  req.setTimeout(1000);\n  return req;\n}\n",
}, [['warning', 'h.js', 3, 'auto']]);
expectFindings('A timeout option with a named handler function that destroys the request is bounded', {
  'h.js': "import http from 'node:http';\nfunction giveUp() { this.destroy(); }\nexport const f = (url) => http.get(url, { timeout: 500 }).on('timeout', giveUp);\n",
}, []);
expectAutoFixHolds('A timeout option and no handler: a destroying handler is chained on the call', { 'h.js': "import http from 'node:http';\nexport const f = (url) => http.get(url, { timeout: 500 });\n" });
expectFindings('https.get(url) on a parameter named for a URL, with no options: an error', {
  'h.js': "import https from 'node:https';\nexport const f = (targetUrl, cb) => https.get(targetUrl, cb);\n",
}, [['error', 'h.js', 2, 'guided']]);
expectFindings('https.get(x) where x is a parameter that could be options: info, not a guess', {
  'h.js': "import https from 'node:https';\nexport const f = (x, cb) => https.get(x, cb);\n",
}, [['info', 'h.js', 2, 'guided']]);
expectFindings('A helper whose signal is a parameter: judged at each caller; shorthand { signal } is followed', {
  'h.js': 'export function get(u, signal) {\n  return fetch(u, { signal });\n}\n',
  'a.js': "import { get } from './h.js';\nexport const bad = () => get('x');\nexport const good = () => get('y', AbortSignal.timeout(1000));\n",
}, [['error', 'a.js', 2, 'guided']]);
expectFindings('A helper whose signal comes from a parameter, and nothing calls it: info', {
  'h.js': 'export function get(u, options) {\n  return fetch(u, options);\n}\n',
}, [['info', 'h.js', 2, 'guided']]);

console.log('\nFix shapes');
expectAutoFixHolds('fetch(u, {}): the empty options become { signal }', { 'a.js': 'export const f = (u) => fetch(u, {});\n' });
expectAutoFixHolds('fetch(u, { method }) inline: signal added first, same line', { 'a.js': "export const f = (u) => fetch(u, { method: 'GET' });\n" });
expectAutoFixHolds('axios.post(u, data): the config argument is appended', { 'a.js': "import axios from 'axios';\nexport const f = (u, d) => axios.post(u, d);\n" });
expectAutoFixHolds('new Pool({ ... }) over several lines: the settings go on a line of their own', { 'a.js': "import pg from 'pg';\nexport const p = new pg.Pool({\n  max: 2,\n});\n" });
expectAutoFixHolds('axios.create() with no config gets one', { 'a.js': "import axios from 'axios';\nconst api = axios.create();\nexport const f = () => api.get('/x');\n" });
expectFindings('fetch(u,) with a trailing comma: guided, not edited', { 'a.js': 'export const f = (u) => fetch(u,);\n' }, [['error', 'a.js', 1, 'guided']]);
{
  let threw = '';
  try { apply(OUT, [{ kind: 'guided', locations: [{ file: 'a.js', line: 1 }], note: 'x' }]); } catch (e) { threw = e.message; }
  ok('apply refuses a guided fix', /only auto fixes/.test(threw));
  try { threw = ''; apply(OUT, [{ kind: 'auto', edits: [{ file: 'dist/a.js', line: 1, column: 1, length: 0, replace: 'x' }] }]); } catch (e) { threw = e.message; }
  ok('apply refuses an edit to build output', /build output/.test(threw));
}

console.log('\nITTEN\'s timing lock (honoured, never written)');
{
  const dir = join(OUT, 'itten-locks');
  rmSync(dir, { recursive: true, force: true });
  const env = { ITTEN_LOCK_DIR: dir, XDG_STATE_HOME: '/nowhere', HOME: '/nowhere' };
  ok('lockDir: $ITTEN_LOCK_DIR first, then $XDG_STATE_HOME/itten/locks, then $HOME/.local/state/itten/locks', LOCK.lockDir(env) === dir && LOCK.lockDir({ XDG_STATE_HOME: '/x', HOME: '/h' }) === '/x/itten/locks' && LOCK.lockDir({ HOME: '/h' }) === '/h/.local/state/itten/locks');
  ok('a missing directory means no locks', LOCK.locks({ env }).length === 0);
  mkdirSync(dir, { recursive: true });
  const now = Date.parse('2026-11-19T12:00:00Z');
  const lock = (o) => JSON.stringify({ format: LOCK.FORMAT, pid: 4242, phase: 'benchmark', taken: '2026-11-19T11:59:00Z', expires: '2026-11-19T12:10:00Z', project: 'shop', ...o });
  const files = {
    'timing-1.json': lock({}),
    'timing-2.json': lock({ pid: 999999 }),
    'timing-3.json': lock({ expires: '2026-11-19T12:00:00Z' }),
    'timing-4.json': '{ not json',
    'timing-5.json': lock({ format: 'itten-timing-lock/2' }),
    'timing-x.json': lock({}),
    'other.json': lock({}),
  };
  for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
  const before = Object.fromEntries(Object.keys(files).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
  const isAlive = (pid) => pid === 4242;
  const seen = Object.fromEntries(LOCK.locks({ env, now, isAlive }).map((l) => [l.file.split('/').pop(), l.state]));
  ok('only timing-<digits>.json are locks', Object.keys(seen).sort().join() === 'timing-1.json,timing-2.json,timing-3.json,timing-4.json,timing-5.json', JSON.stringify(seen));
  ok('active: parses, the format matches, the pid is alive, now before expires', seen['timing-1.json'] === 'active');
  ok('stale: the pid is dead', seen['timing-2.json'] === 'stale');
  ok('stale: now at expires', seen['timing-3.json'] === 'stale');
  ok('a file that cannot be parsed counts as active', seen['timing-4.json'] === 'active');
  ok('a lock in another format, live pid, future expiry, counts as active (docs/decisions.md, Q5)', seen['timing-5.json'] === 'active');
  ok('describe names the file, phase, project, pid and expiry', /timing-1\.json: ITTEN benchmark run of shop, pid 4242, until 2026-11-19T12:10:00Z/.test(LOCK.describe(LOCK.active({ env, now, isAlive })[0])));
  const t0 = Date.now();
  const lines = [];
  const waitLog = join(OUT, 'lock-waits.jsonl');
  rmSync(waitLog, { force: true });
  const held = await LOCK.waitForNoLock({ env, now, isAlive, limitMs: 1500, log: (l) => lines.push(l), logFile: waitLog, label: 'unit' });
  const rec = existsSync(waitLog) ? JSON.parse(readFileSync(waitLog, 'utf8').trim().split('\n').at(-1)) : null;
  ok('a wait is logged with the lock\'s phase, taken and expires, then how long it lasted and the total; one JSON line per wait', /^lock-wait: unit: waiting on ITTEN's lock: phase \S+, taken \S+, expires \S+/.test(lines[0] ?? '') && /waited \d+\.\d s .*limit reached; total waited by this process \d+\.\d s/.test(lines.at(-1) ?? '') && rec?.outcome === 'limit reached' && rec.ms >= 1000 && rec.segments.length >= 1 && 'phase' in rec.segments[0] && 'expires' in rec.segments[0], lines.join(' | '));
  ok('waitForNoLock rereads until its limit, then returns the active lock', !!held && Date.now() - t0 >= 1400, `${Date.now() - t0} ms`);
  ok('nothing in the lock directory is written or deleted', Object.entries(before).every(([f, t]) => existsSync(join(dir, f)) && readFileSync(join(dir, f), 'utf8') === t) && readdirSync(dir).length === Object.keys(files).length);
  for (const f of ['timing-1.json', 'timing-4.json', 'timing-5.json']) rmSync(join(dir, f));
  ok('with only stale and non-lock files left, nothing is active', (await LOCK.waitForNoLock({ env, now, isAlive, limitMs: 0, log: () => {} })) === null);
  // A running Lima VM is waited on like a lock (the owner, 20 November 2026).
  const vmLines = [];
  const vmLog = join(dir, 'vm-waits.jsonl');
  let vmChecks = 0;
  const vmHeld = await LOCK.waitForNoLock({ env, now, isAlive, vms: () => (++vmChecks < 3 ? ['bench-vm'] : []), limitMs: 10_000, log: (l) => vmLines.push(l), logFile: vmLog, label: 'unit-vm' });
  ok('a running Lima VM is waited on, the wait logged with its name, and the wait ends when it stops', vmHeld === null && vmChecks === 3 && /waiting on a running Lima VM, bench-vm \(limactl list\)/.test(vmLines.join('\n')) && /"phase":"Lima VM bench-vm"/.test(readFileSync(vmLog, 'utf8')), vmLines.join('\n'));
  ok('  describe names the VM', LOCK.describe(LOCK.active({ env, now, isAlive, vms: () => ['bench-vm'] }).find((l) => l.vm)) === 'Lima VM bench-vm is running (limactl list)');
  ok('  a caller with its own env and no vms sees no VMs (limactl not consulted)', LOCK.active({ env, now, isAlive }).every((l) => !l.vm));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\nThe load guard: loopback only, within caps');
{
  const refused = (f) => { try { f(); return false; } catch (e) { return e instanceof GUARD.Refused; } };
  ok('checkTarget: a twin on 127.0.0.1 with a port is loaded', GUARD.checkTarget('http://127.0.0.1:41234/orders/1').port === '41234');
  const base = 'http://127.0.0.1:41234';
  const sc = (path, background) => () => scenario({ base, step: { id: 's', path, rate: 1, seconds: 1, ...(background ? { background: { path: background, rate: 1 } } : {}) }, summaryFile: 'x.json', vus: 10 });
  ok('scenario: a path on the twin is written into the script', sc('/orders/1')().includes('http://127.0.0.1:41234/orders/1'));
  ok('scenario: a path that resolves to another host is refused, not only a base that does', refused(sc('//example.com/x')) && refused(sc('http://example.com/x')) && refused(sc('/\\example.com/x')) && refused(sc('orders')));
  ok('scenario: a background path to another host is refused too', refused(sc('/orders/1', '//example.com/x')) && !refused(sc('/orders/1', '/health')));
  ok('checkTarget: ::1 and localhost are loopback too', !refused(() => GUARD.checkTarget('http://[::1]:8080/')) && !refused(() => GUARD.checkTarget('http://localhost:8080/')));
  ok('checkTarget: any other host is refused, with no override', ['http://10.0.0.5:80/', 'http://example.com:80/', 'http://127.0.0.2:80/', 'http://0.0.0.0:80/', 'http://169.254.169.254:80/'].every((u) => refused(() => GUARD.checkTarget(u))));
  ok('checkTarget: https, and a URL with no port, are refused', refused(() => GUARD.checkTarget('https://127.0.0.1:443/')) && refused(() => GUARD.checkTarget('http://127.0.0.1/')));
  ok('profile: CI=true is ci, anything else local', GUARD.profile({ CI: 'true' }) === 'ci' && GUARD.profile({}) === 'local');
  ok('profile: ci-long only in CI and only when asked; the same rate and step caps, a longer run', GUARD.profile({ CI: 'true', ERLANG_LOAD_PROFILE: 'ci-long' }) === 'ci-long' && GUARD.profile({ ERLANG_LOAD_PROFILE: 'ci-long' }) === 'local' && GUARD.CAPS['ci-long'].rate === GUARD.CAPS.ci.rate && GUARD.CAPS['ci-long'].stepSeconds === GUARD.CAPS.ci.stepSeconds && GUARD.CAPS['ci-long'].runSeconds > GUARD.CAPS.ci.runSeconds);
  ok('checkStep: within the local caps', !refused(() => GUARD.checkStep({ id: 's', rate: 150, seconds: 20 }, GUARD.CAPS.local)));
  ok('checkStep: over the local rate or step length is refused; CI allows more', refused(() => GUARD.checkStep({ id: 's', rate: 300, seconds: 10 }, GUARD.CAPS.local)) && refused(() => GUARD.checkStep({ id: 's', rate: 50, seconds: 30 }, GUARD.CAPS.local)) && !refused(() => GUARD.checkStep({ id: 's', rate: 300, seconds: 30 }, GUARD.CAPS.ci)));
  ok('checkStep: a rate or length that is not positive is refused', refused(() => GUARD.checkStep({ id: 's', rate: 0, seconds: 10 }, GUARD.CAPS.ci)) && refused(() => GUARD.checkStep({ id: 's', rate: 10 }, GUARD.CAPS.ci)));
  ok('checkRun: both twins, every repeat: 2 x 3 x 35 s = 210 s', GUARD.checkRun({ steps: [{ id: 'a', rate: 50, seconds: 15 }, { id: 'b', rate: 150, seconds: 20 }] }, GUARD.CAPS.local) === 210);
  ok('checkRun: over the run cap is refused', refused(() => GUARD.checkRun({ repeats: 10, steps: [{ id: 'a', rate: 50, seconds: 20 }, { id: 'b', rate: 50, seconds: 20 }] }, GUARD.CAPS.local)));
  const text = k6Scenario({ base: 'http://127.0.0.1:5000', step: { id: 'past', method: 'GET', path: '/orders/1', rate: 150, seconds: 20, okMs: 500, timeoutMs: 5000 }, summaryFile: '/x/s.json', vus: 400 });
  ok('k6 scenario: an open model at the step\'s rate, to the twin only', text.includes("executor: 'constant-arrival-rate', rate: 150") && text.includes("duration: '20s'") && text.includes('"http://127.0.0.1:5000/orders/1"') && text.includes('maxVUs: 400'));
  ok('k6 scenario: a target that is not loopback is refused before any script is written', refused(() => k6Scenario({ base: 'http://203.0.113.9:80', step: { id: 'x', path: '/', rate: 1, seconds: 1 }, summaryFile: 'x', vus: 1 })));
}

console.log('\nThe load judge (shedding), on recorded runs');
{
  const form = join(OUT, 'load-l12');
  rmSync(form, { recursive: true, force: true });
  for (const d of ['planted', 'clean', 'load']) cpSync(join(ROOT, 'fixtures', 'L12-no-load-shedding', d), join(form, d), { recursive: true });
  const out = join(form, 'out');
  // A step's record: ok, late, refused and failed out of rate x seconds.
  const step = (id, rate, seconds, [okN, late, refused, failed], env = { load1: 0.5 }) => ({ id, method: 'GET', path: '/orders/1', route: '/orders/:id', rate, seconds, interrupted: false, counts: { requests: okN + late + refused + failed, ok: okN, late, refused, failed, dropped: 0 }, served: { medMs: 100, p90Ms: 150, p99Ms: late ? 2100 : 180, maxMs: 2200 }, refusals: refused ? { medMs: 2, p90Ms: 3, p99Ms: 4, maxMs: 9 } : null, samples: [], environment: { before: { load1: env.load1, cpus: 8 }, after: { load1: env.load1, cpus: 8, cooledAfterS: env.cooled === false ? null : 5 } } });
  const run = (twins) => {
    rmSync(out, { recursive: true, force: true });
    for (const t of ['planted', 'clean']) mkdirSync(join(out, t), { recursive: true });
    writeFileSync(join(out, 'raw.json'), JSON.stringify({ profile: 'ci', k6: 'k6 v2.3.0', fixture: 'L12', form: 'express', repeats: twins }));
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'load', 'judge.js'), form, out], { encoding: 'utf8' });
    return { code: r.status, text: r.stdout + r.stderr, planted: existsSync(join(out, 'planted', 'report.json')) ? JSON.parse(readFileSync(join(out, 'planted', 'report.json'), 'utf8')) : null };
  };
  const queued = (k, env) => ({ planted: { steps: [step('below', 50, 15, [745, 0, 0, 5], env), step('past', 150, 20, [30 + k, 1960, 0, 1010 - k], env)] }, clean: { steps: [step('below', 50, 15, [748, 0, 0, 2], env), step('past', 150, 20, [1990 - k, 0, 1010 + k, 0], env)] } });
  const good = run([0, 3, 7, 11, 15].map((k) => queued(k)));
  const f = good.planted?.findings[0];
  ok('shedding: the queueing twin is reported, the capped twin is not', good.code === 0 && /PASS  L12 express load planted: 1\/1/.test(good.text) && /PASS  L12 express load clean: 0/.test(good.text), good.text.trim());
  ok('  linked to the static finding by symbol, with load in its detection and its fingerprint unchanged', !!f && f.detection.includes('static') && f.detection.includes('load') && f.fingerprint === scan(join(form, 'planted')).findings.find((s) => s.check === 'no-load-shedding')?.fingerprint, f && JSON.stringify(f.detection));
  ok('  the measured shares are in erlang.load, never in the fingerprint', !!f && f.erlang.load.samples.length === 5 && f.erlang.load.timing.reliable === true && !/\d\.\d/.test(f.fingerprint), f?.fingerprint);
  // The relative timing rule (Q8): five pairs, all, none, or a mix.
  const busy = run([0, 3, 6, 9, 12].map((k) => queued(k, { load1: 6 })));
  ok('relative rule: on a busy machine, five pairs that all show the gap: a failing finding, the load averages recorded only', busy.code === 0 && /PASS  L12 express load planted: 1\/1/.test(busy.text) && /load before 6\/8 CPUs/.test(busy.text), busy.text);
  const wide = run([0, 100, 200, 300, 400].map((k) => queued(k)));
  ok('  a spread of 51% with every pair over the bar: a failing finding (spread recorded, not consulted)', wide.code === 0 && /PASS  L12 express load planted: 1\/1/.test(wide.text) && /spread 5\d\.\d%/.test(wide.text), wide.text);
  const hot = run([0, 3, 6, 9, 12].map((k) => queued(k, { load1: 0.5, cooled: false })));
  ok('  a load average that never cooled is recorded, not a gate', hot.code === 0 && /never cooled/.test(hot.text), hot.text);
  const onePair = run([0, 3, 6, 9, 12].map((k) => { const q = queued(k); if (k === 9) q.planted = queued(k).clean; return q; }));
  ok('  a pair that does not show the gap: info, timing unreliable, 4 of 5, and the form is UNRELIABLE (exit 3), never a pass', onePair.code === 3 && /UNRELIABLE  L12 express load planted: .*4 of 5 repeats cleared the threshold/.test(onePair.text) && !/^PASS  L12 express load planted/m.test(onePair.text), onePair.text);
  const three = run([0, 7, 15].map((k) => queued(k)));
  ok('  three pairs are too few: UNRELIABLE, fewer than 5', three.code === 3 && /3 repeat\(s\), fewer than 5/.test(three.text), three.text);
  const same = run([0, 3, 6, 9, 12].map((k) => { const q = queued(k); return { planted: q.clean, clean: q.clean }; }));
  ok('  the control: no pair shows the gap: no finding, the defect missed, no clean false positive', same.code === 1 && /missed no-load-shedding step past/.test(same.text) && /PASS  L12 express load clean: 0/.test(same.text), same.text.trim());
  const broken = run([0, 3, 7, 11, 15].map((k) => { const q = queued(k); q.clean.steps[0] = step('below', 50, 15, [300, 450, 0, 0]); return q; }));
  ok('shedding: a twin that is late below the knee stops the judge: the form is wrong', broken.code !== 0 && /below the knee: the fixture or its load form is wrong/.test(broken.text), broken.text.trim().slice(0, 300));
  rmSync(form, { recursive: true, force: true });
}

console.log('\nThe load judge (compare), on recorded runs');
{
  const form = join(OUT, 'load-l08');
  rmSync(form, { recursive: true, force: true });
  for (const d of ['planted', 'clean', 'load']) cpSync(join(ROOT, 'fixtures', 'L08-pool-exhaustion', d), join(form, d), { recursive: true });
  const out = join(form, 'out');
  const step = (id, route, failed, k = 0) => ({ id, method: id === 'getOrder' ? 'GET' : 'POST', path: '/x', route, rate: 20, seconds: 10, interrupted: false, counts: { requests: 200, ok: 200 - failed - k, late: k, refused: 0, failed, dropped: 0 }, served: { medMs: 510, p90Ms: 600, p99Ms: 900, maxMs: 1000 }, refusals: null, samples: [], environment: { before: { load1: 0.5, cpus: 8 }, after: { load1: 0.5, cpus: 8, cooledAfterS: 5 } } });
  const run = (planted, clean) => {
    rmSync(out, { recursive: true, force: true });
    for (const t of ['planted', 'clean']) mkdirSync(join(out, t), { recursive: true });
    writeFileSync(join(out, 'raw.json'), JSON.stringify({ profile: 'ci', fixture: 'L08', form: 'fastify', repeats: [0, 1, 2].map((k) => ({ planted: { steps: planted(k) }, clean: { steps: clean(k) } })) }));
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'load', 'judge.js'), form, out], { encoding: 'utf8' });
    return { code: r.status, text: (r.stdout + r.stderr).trim() };
  };
  const held = (k) => [step('getOrder', '/orders/:id', 0), step('payOrder', '/orders/:id/pay', 100 + k), step('shipOrder', '/orders/:id/ship', 98 + k)];
  const released = () => [step('getOrder', '/orders/:id', 0), step('payOrder', '/orders/:id/pay', 0), step('shipOrder', '/orders/:id/ship', 0)];
  const good = run(held, released);
  ok('compare: requests failing to get a connection, on the two routes that call out, in the planted twin only', good.code === 0 && /planted: 2\/2/.test(good.text) && /clean: 0/.test(good.text), good.text);
  const alike = run(released, released);
  ok('  the control: twins that both release in time give nothing, and both defects are missed', alike.code === 1 && /missed pool-exhaustion step payOrder; missed pool-exhaustion step shipOrder/.test(alike.text), alike.text);
  const busyStep = (id, route, failed) => { const s = step(id, route, failed); s.environment = { before: { load1: 6, cpus: 8 }, after: { load1: 6, cpus: 8, cooledAfterS: null } }; return s; };
  const busy = run((k) => [busyStep('getOrder', '/orders/:id', 0), busyStep('payOrder', '/orders/:id/pay', 100 + k * 9), busyStep('shipOrder', '/orders/:id/ship', 98 + k * 9)], () => released().map((s) => busyStep(s.id, s.route, 0)));
  ok('compare: a share of failed requests is exempt from the timing rule: on a busy machine, with an 18% spread, still failing findings (exit 0)', busy.code === 0 && /planted: 2\/2/.test(busy.text) && /exempt from the timing rule/.test(busy.text), busy.text);
  const decoy = run((k) => [step('getOrder', '/orders/:id', 90 + k), ...held(k).slice(1)], released);
  ok('  a decoy step that fails in the planted twin only is a false positive', decoy.code === 1 && /decoy reported: pool-exhaustion STB-09 getOrder/.test(decoy.text), decoy.text);
  rmSync(form, { recursive: true, force: true });
}
{
  // L09: a cheap route's late share while a heavy one runs beside it; the
  // finding is about the heavy route.
  const form = join(OUT, 'load-l09');
  rmSync(form, { recursive: true, force: true });
  for (const d of ['planted', 'clean', 'load']) cpSync(join(ROOT, 'fixtures', 'L09-blocking-work', d), join(form, d), { recursive: true });
  const out = join(form, 'out');
  // signup is judged on the event loop's longest stretch (loop.maxMs): about
  // 175 ms where the hashing runs on the main thread, 4 ms where it does not.
  const step = (id, late) => ({ id, method: 'GET', path: '/avatars/1', route: '/avatars/:id', rate: 20, seconds: 10, interrupted: false, ...(id === 'signup' ? { loop: { maxMs: late > 20 ? 170 + (late % 10) : 4, meanMs: 1 } } : {}), counts: { requests: 200, ok: 200 - late, late, refused: 0, failed: 0, dropped: 0 }, served: { medMs: 5, p90Ms: 9, p99Ms: 20, maxMs: 30 }, refusals: null, samples: [], environment: { before: { load1: 0.5, cpus: 8 }, after: { load1: 0.5, cpus: 8, cooledAfterS: 5 } } });
  const run = (planted) => {
    rmSync(out, { recursive: true, force: true });
    for (const t of ['planted', 'clean']) mkdirSync(join(out, t), { recursive: true });
    const clean = () => ['signup', 'login', 'export', 'codes'].map((id) => step(id, 4));
    writeFileSync(join(out, 'raw.json'), JSON.stringify({ profile: 'ci', fixture: 'L09', form: 'express', repeats: [0, 1, 2, 3, 4].map((k) => ({ planted: { steps: planted(k) }, clean: { steps: clean() } })) }));
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'load', 'judge.js'), form, out], { encoding: 'utf8' });
    return { code: r.status, text: (r.stdout + r.stderr).trim(), report: JSON.parse(readFileSync(join(out, 'planted', 'report.json'), 'utf8')) };
  };
  const good = run((k) => [step('signup', 180 + k), step('login', 190 + k), step('export', 150 + k), step('codes', 4)]);
  const routes = good.report.findings.filter((f) => f.severity !== 'info').map((f) => f.where.endpoints?.[0]?.route ?? f.erlang?.route ?? JSON.stringify(f.where)).join(' ');
  ok('compare with a background: the loop held while signup runs, avatars late while login and export run, reported on those routes, not on /avatars', good.code === 0 && !/avatars/.test(routes), `${good.text}\n${routes}`);
  const alike = run(() => ['signup', 'login', 'export', 'codes'].map((id) => step(id, 4)));
  ok('  the control: twins whose avatars are never late give nothing, and the three defects are missed', alike.code === 1 && /0\/3/.test(alike.text), alike.text);
  const near = run((k) => [step('signup', 180 + k), step('login', 190 + k), step('export', 150 + k), step('codes', 40)]);
  ok('  decoy margin: a decoy step late 0.2 of the time, under the 0.3 floor but over half of it and over half the ratio, is not reported yet fails the form', near.code === 1 && /^DECOY  L09 express load planted step codes \(late-share\): .*OVER on the median/m.test(near.text) && /^FAIL  L09 express load decoy margin/m.test(near.text) && !/decoy reported/.test(near.text), near.text);
  ok('  with every decoy under half way, the margin lines pass', /^DECOY  L09 express load clean step codes \(late-share\): \[0\.02,/m.test(good.text) && !/OVER/.test(good.text), good.text);
  // Planted margin: export late 0.75 of the time keeps it (0.6 is twice the
  // 0.3 floor); late 0.5 clears the bar, is found, and fails the margin.
  ok('  planted margin: defects clearing every condition by 2x print PLANTED lines and pass', /^PLANTED  L09 express load planted step export \(late-share\): \[0\.75,/m.test(good.text) && !/SHORT/.test(good.text), good.text);
  const thin = run((k) => [step('signup', 180 + k), step('login', 190 + k), step('export', 100), step('codes', 4)]);
  ok('  a planted share of 0.5, over the 0.3 bar but under twice it, is found and fails the planted margin (exit 1)', thin.code === 1 && /^PASS  L09 express load planted: 3\/3/m.test(thin.text) && /^PLANTED  L09 express load planted step export \(late-share\): \[0\.5,.*twice the floor 0\.6.*SHORT on the median/m.test(thin.text) && /^FAIL  L09 express load planted margin/m.test(thin.text), thin.text);
  // The median rule (the owner, 20 November 2026): one pair past the margin
  // but inside the bar is an OUTLIER, printed, not failed.
  const onePlanted = run((k) => [step('signup', 180 + k), step('login', 190 + k), step('export', k === 2 ? 100 : 150 + k), step('codes', 4)]);
  ok('  one planted pair at 0.5 (over the bar, under the margin), the others 0.75: an OUTLIER with its load averages, not failed', onePlanted.code === 0 && /^OUTLIER  L09 express load planted step export \(late-share\): short of the planted margin but clearing the bar \(not failed\): pair 3: 0\.5 against 0\.02; load /m.test(onePlanted.text) && !/SHORT|BELOW/.test(onePlanted.text), onePlanted.text);
  const oneDecoy = run((k) => [step('signup', 180 + k), step('login', 190 + k), step('export', 150 + k), step('codes', k === 1 ? 40 : 4)]);
  ok('  one decoy pair late 0.2 (past half the floor, under the bar), the others 0.02: an OUTLIER, not failed', oneDecoy.code === 0 && /^OUTLIER  L09 express load planted step codes \(late-share\): past the decoy margin but inside the bar \(not failed\): pair 2: 0\.2 against 0\.02/m.test(oneDecoy.text) && !/OVER|REACHED/.test(oneDecoy.text), oneDecoy.text);
  const decoyBar = run((k) => [step('signup', 180 + k), step('login', 190 + k), step('export', 150 + k), step('codes', k === 1 ? 80 : 4)]);
  ok('  one decoy pair late 0.4, past the judge\'s bar: fails outright', decoyBar.code === 1 && /REACHED THE BAR in pair\(s\) 2/.test(decoyBar.text) && /^FAIL  L09 express load decoy margin/m.test(decoyBar.text), decoyBar.text);
  rmSync(form, { recursive: true, force: true });
}

console.log('\nThe load judge (heap slope), on recorded runs');
{
  // L05: the heap after a full collection against responses answered, every
  // 2 s through a step; the slope per request, twin against twin.
  const form = join(OUT, 'load-l05');
  rmSync(form, { recursive: true, force: true });
  for (const d of ['planted', 'clean', 'load']) cpSync(join(ROOT, 'fixtures', 'L05-memory-growth', d), join(form, d), { recursive: true });
  const out = join(form, 'out');
  const spec = JSON.parse(readFileSync(join(form, 'load', 'load.json'), 'utf8'));
  // A step whose heap grows by perReq bytes a response, plus a wobble.
  const step = ({ id, method = 'GET', path, route }, perReq, k) => ({ id, method, path, route, rate: 100, seconds: 15, interrupted: false, counts: { requests: 1500, ok: 1500, late: 0, refused: 0, failed: 0, dropped: 0 }, served: { medMs: 2, p90Ms: 3, p99Ms: 5, maxMs: 9 }, refusals: null, samples: [], environment: { before: { load1: 6, cpus: 8 }, after: { load1: 6, cpus: 8, cooledAfterS: 5 } }, heap: { points: Array.from({ length: 8 }, (_, j) => ({ t: 2 * j, answered: 200 * j, heapUsed: 9e6 + perReq * 200 * j + ((j * 7919 + k * 31) % 5) * 300 })) } });
  const run = (planted, clean, n = 5) => {
    rmSync(out, { recursive: true, force: true });
    for (const t of ['planted', 'clean']) mkdirSync(join(out, t), { recursive: true });
    const twin = (per, k) => ({ steps: spec.steps.filter((s) => s.metric).map((s) => step(s, per(s.id, k), k)) });
    writeFileSync(join(out, 'raw.json'), JSON.stringify({ profile: 'ci', fixture: 'L05', form: 'express', repeats: Array.from({ length: n }, (_, k) => ({ planted: twin(planted, k), clean: twin(clean, k) })) }));
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'load', 'judge.js'), form, out], { encoding: 'utf8' });
    return { code: r.status, text: (r.stdout + r.stderr).trim() };
  };
  const clean = (id) => ({ searchProducts: 0, suggest: 200, createOrder: 110, orderLines: 0, placeCart: 0 })[id];
  const planted = (id, k) => ({ searchProducts: 370 + k, suggest: 200, createOrder: 186, orderLines: 0, placeCart: 2400 + 10 * k })[id];
  const good = run(planted, clean);
  ok('heap slope: the cache and the idempotency store are reported on a busy machine (per pair, the relative rule; the load average recorded only); the decoys are not', good.code === 0 && /PASS  L05 express load planted: 2\/2/.test(good.text) && /PASS  L05 express load clean: 0/.test(good.text), good.text);
  ok('  the expected miss (createOrder, about 1.7 times the clean twin) is not reported and does not fail the form', /EXPECTED  L05 express load planted: memory-growth STB-05 step createOrder, below the detection floor .*not found, as documented/.test(good.text), good.text);
  const wide = run((id, k) => (id === 'placeCart' ? 1500 + 400 * k : planted(id, k)), clean);
  ok('  slopes that spread 70% over the pairs, every pair over the bar: still reported (the spread recorded, not consulted)', wide.code === 0 && /PASS  L05 express load planted: 2\/2/.test(wide.text), wide.text);
  const onePair = run((id, k) => (id === 'searchProducts' && k === 3 ? 0 : planted(id, k)), clean);
  ok('  a pair whose slope does not clear: info, timing unreliable, 4 of 5, never a pass; that pair is below the judge\'s bar, so the planted margin fails too (exit 1)', onePair.code === 1 && /UNRELIABLE  L05 express load planted: memory-growth STB-05 step searchProducts: timing unreliable .*4 of 5 repeats cleared/.test(onePair.text) && /^PLANTED  L05 express load planted step searchProducts \(heap-slope\): .*BELOW THE BAR in pair\(s\) 4/m.test(onePair.text), onePair.text);
  // Heap slopes are under both margin tests, on the median (the owner, 20
  // November 2026).
  ok('  heap slope: PLANTED lines for both defects, DECOY lines for the decoy routes, EXPECTED-MISS for createOrder', /^PLANTED  L05 express load planted step placeCart \(heap-slope\)/m.test(good.text) && /^DECOY  L05 express load planted step suggest \(heap-slope\)/m.test(good.text) && /^DECOY  L05 express load clean step placeCart \(heap-slope\)/m.test(good.text) && /^EXPECTED-MISS  L05 express load planted step createOrder/m.test(good.text), good.text);
  const nearSuggest = run((id, k) => (id === 'suggest' ? 330 : planted(id, k)), clean);
  ok('  a decoy slope 1.65 times the clean twin\'s in every pair (under the 3x bar, over half of it): over on the median, the form fails with nothing reported', nearSuggest.code === 1 && /^DECOY  L05 express load planted step suggest \(heap-slope\): .*OVER on the median/m.test(nearSuggest.text) && /^PASS  L05 express load planted: 2\/2/m.test(nearSuggest.text), nearSuggest.text);
  const thinSlope = run(planted, (id) => (id === 'searchProducts' ? 100 : clean(id)));
  ok('  a planted slope 3.7 times the clean twin\'s (over the 3x bar, under 6x): short on the median, the form fails', thinSlope.code === 1 && /^PLANTED  L05 express load planted step searchProducts \(heap-slope\): .*SHORT on the median/m.test(thinSlope.text), thinSlope.text);
  const three = run(planted, clean, 3);
  ok('  three pairs are too few: unreliable, fewer than 5', three.code === 3 && /3 repeat\(s\), fewer than 5/.test(three.text), three.text);
  const same = run(clean, clean);
  ok('  the control: twins that keep alike give no finding, and both defects are missed', same.code === 1 && /missed memory-growth step searchProducts/.test(same.text) && /missed memory-growth step placeCart/.test(same.text), same.text);
  rmSync(form, { recursive: true, force: true });
}

console.log('\nAn internal failure exits 70');
{
  const out = join(OUT, 'crash');
  rmSync(out, { recursive: true, force: true });
  for (const t of ['planted', 'clean']) { mkdirSync(join(out, t), { recursive: true }); writeFileSync(join(out, t, 'raw.json'), '{'); }
  writeFileSync(join(out, 'raw.json'), '{');
  for (const [label, judge, form] of [['trace judge', 'trace', 'L05-memory-growth'], ['load judge', 'load', 'L05-memory-growth']]) {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', judge, 'judge.js'), join(ROOT, 'fixtures', form), out], { encoding: 'utf8' });
    ok(`${label}: a raw.json that cannot be parsed is a crash: exit 70, not 1`, r.status === 70 && new RegExp(`^${label}: internal failure \\(exit 70\\)`, 'm').test(r.stderr), `exit ${r.status}: ${r.stderr.trim().split('\n')[0]}`);
  }
  rmSync(out, { recursive: true, force: true });
  // A module that throws while it loads: each entry (bin/erlang.js and both
  // judges, which import nothing statically) exits 70, not Node's 1.
  const boot = join(OUT, 'boot');
  rmSync(boot, { recursive: true, force: true });
  for (const [label, entry, real] of [['erlang', 'bin/erlang.js', 'lib/erlang.js'], ['trace judge', 'scripts/trace/judge.js', 'scripts/trace/judge-main.js'], ['load judge', 'scripts/load/judge.js', 'scripts/load/judge-main.js']]) {
    for (const f of [entry, real]) mkdirSync(dirname(join(boot, f)), { recursive: true });
    cpSync(join(ROOT, entry), join(boot, entry));
    writeFileSync(join(boot, real), "throw new Error('broken while loading');\n");
    const r = spawnSync(process.execPath, [join(boot, entry), 'x', 'y'], { encoding: 'utf8' });
    ok(`${entry}: a module that throws while loading exits 70, internal failure`, r.status === 70 && new RegExp(`^${label}: internal failure \\(exit 70\\): Error: broken while loading`).test(r.stderr), `exit ${r.status}: ${r.stderr.trim().split('\n')[0]}`);
  }
  rmSync(boot, { recursive: true, force: true });
}

console.log('\nAbsolute waits: the delay the code declares, not a clock');
{
  // Attempts at 0, 1,003 and 2,005 ms (a busy machine's clock); a 2,000 ms
  // request deadline set with each attempt; a fixed 1,000 ms wait declared.
  const at = [0, 1003.4, 2005.1];
  const deadlines = at.map((a) => ({ ms: 2000, at: a + 0.2 }));
  const fixed = declaredWaits(at, [...deadlines, { ms: 1000, at: 2.1 }, { ms: 1000, at: 1004.9 }]);
  ok('a fixed wait is read as declared, 1,000 ms each gap, whatever the clock measured', JSON.stringify(fixed) === '[1000,1000]', JSON.stringify(fixed));
  const jitter = declaredWaits(at, [...deadlines, { ms: 1.13, at: 0.9 }, { ms: 0, at: 500 }, { ms: 731.2, at: 1004.9 }]);
  ok('  a jittered wait, a draw of 1.13 ms included, is read as drawn; a 0 ms timer is not a wait', JSON.stringify(jitter) === '[1.13,731.2]', JSON.stringify(jitter));
  ok('  a gap with no timer that fired in it is null (not judged: info)', JSON.stringify(declaredWaits(at, deadlines)) === '[null,null]');
  ok('  no timers recorded at all is null', declaredWaits(at, undefined) === null);
}

{
  const { waitVerdict } = TIMING;
  const run = (attempts, timers) => ({ attempts, timers });
  const deadline = (a) => ({ ms: 2000, at: a + 0.2 });
  const fixed = waitVerdict([run([0, 1001, 2002], [deadline(0), { ms: 1000, at: 0.5 }, deadline(1001), { ms: 1000, at: 1001.5 }]), run([0, 1003], [{ ms: 1000, at: 1 }])], 20);
  ok('waits: three declared 1,000 ms waits across runs are fixed', fixed.kind === 'fixed' && fixed.waits.join() === '1000,1000,1000', JSON.stringify(fixed));
  const spaced = waitVerdict([run([0, 1001, 2002], [deadline(0), { ms: 1000, at: 0.5 }, deadline(1001)])], 20);
  ok('  attempts 1 s apart with no timer seen in one gap: unobserved (info), not clean', spaced.kind === 'unobserved' && spaced.unseen.length === 1 && Math.round(spaced.unseen[0].gap) === 1001, JSON.stringify(spaced));
  const jit = waitVerdict([run([0, 120, 600], [{ ms: 118.2, at: 0.5 }, { ms: 477.9, at: 121 }])], 20);
  ok('  jittered waits are varied (nothing reported)', jit.kind === 'varied');
  let threw = false; try { waitVerdict([run([0, 1000], undefined)], 20); } catch { threw = true; }
  ok('  a run with no timers recorded is a harness fault (throws), not a verdict', threw);
}
{
  // The harness's timer recording (scripts/trace/timers.js), in a fresh
  // process: each way of waiting is recorded with the delay asked for.
  const code = `
    const T = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'scripts', 'trace', 'timers.js')).href)});
    T.install(); T.start();
    const tp = await import('node:timers/promises');
    const { setTimeout: cb } = await import('node:timers');
    await tp.setTimeout(31);
    await tp.scheduler.wait(32);
    await new Promise((ok) => cb(ok, 33));
    await new Promise((ok) => setTimeout(ok, 34));
    console.log(JSON.stringify(T.take().map((t) => [t.ms, t.via])));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  const got = r.status === 0 ? JSON.parse(r.stdout) : null;
  const has = (ms, via) => got?.some(([m, v]) => m === ms && v === via);
  ok('timers: node:timers/promises setTimeout and scheduler.wait, node:timers setTimeout and the global setTimeout are each recorded with their declared delay',
    has(31, 'timers/promises setTimeout') && has(32, 'scheduler.wait') && has(33, 'setTimeout') && has(34, 'setTimeout'), r.stdout.trim() || r.stderr.trim());
}

console.log('\nMeasured and declared values; the release gate\'s comparison');
{
  const { text, measured: m, declared: d } = await import('../lib/values.js');
  const inner = text`${m('ms', 12.4, '12')} ms`;
  const t = text`GET /x {cached} took ${inner} and ${m('ms', 3)} more, under ${d('barMs', 20)} ms`;
  ok('values: the message shows each value; the template names it; repeated names are numbered; literal braces are doubled',
    t.message === 'GET /x {cached} took 12 ms and 3 more, under 20 ms' && t.template === 'GET /x {{cached}} took {ms} ms and {ms2} more, under {barMs} ms' && JSON.stringify(t.values) === '{"measured":{"ms":12.4,"ms2":3},"declared":{"barMs":20}}', JSON.stringify(t));
  const dir = join(OUT, 'compare');
  const write = (run, findings) => { mkdirSync(join(dir, run, 'F', 'planted'), { recursive: true }); writeFileSync(join(dir, run, 'F', 'planted', 'report.json'), JSON.stringify({ schema: 'report/1', started: run, findings })); };
  const f = (ms, { bar = 20, severity = 'warning', template } = {}) => {
    const x = text`took ${m('ms', ms)} ms, over ${d('barMs', bar)} ms`;
    return { check: 'c', severity, fingerprint: 'c|x', measured: ['message', 'erlang.values.measured', 'erlang.trace.samples'], message: x.message, erlang: { values: x.values, template: template ?? x.template, trace: { judge: 'timing', samples: [ms, ms + 1] } } };
  };
  const cmp = (a, b) => { rmSync(dir, { recursive: true, force: true }); write('a', a); write('b', b); const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'compare-reports.js'), join(dir, 'a'), join(dir, 'b')], { encoding: 'utf8' }); return { code: r.status, text: r.stdout + r.stderr }; };
  ok('compare: findings that differ only in what each lists as measured (its message\'s numbers, measured values, evidence) are identical', cmp([f(31)], [f(47)]).code === 0);
  const declared = cmp([f(31)], [f(31, { bar: 25 })]);
  ok('  a declared value that differs is a difference', declared.code === 1 && /erlang\.values\.declared\.barMs/.test(declared.text), declared.text);
  const template = cmp([f(31)], [f(31, { template: 'took {ms} ms, far over {barMs} ms' })]);
  ok('  a message template that differs is a difference', template.code === 1 && /erlang\.template/.test(template.text), template.text);
  ok('  a severity that differs, or a finding in one run only, is a difference', cmp([f(31)], [f(31, { severity: 'info' })]).code === 1 && cmp([f(31)], []).code === 1);
  const bare = (msg) => ({ check: 'c', severity: 'error', fingerprint: 'c|y', measured: ['message'], message: msg });
  ok('  with no template, "message" in measured compares the message with its numbers masked (finding/1)', cmp([bare('3 attempts in 1,002 ms')], [bare('4 attempts in 998 ms')]).code === 0 && cmp([bare('3 attempts in 1,002 ms')], [bare('3 tries in 1,002 ms')]).code === 1);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\nThe release gate\'s rows: planted, decoys, and "timing unreliable" infos');
{
  // L11's trace form: three planted rows (fixtures/L11-cold-start/trace/trace.json).
  const dir = join(OUT, 'gate');
  const spec = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'L11-cold-start', 'trace', 'trace.json'), 'utf8'));
  const finding = (method, route, severity, reliable = severity !== 'info') => ({ check: 'cold-start', rules: ['STB-10'], severity, fingerprint: `cold-start|${route}`, where: { endpoints: [{ method, route }] }, message: `${method} ${route}`, measured: ['erlang.trace.timing'], erlang: { trace: { judge: 'starts', timing: { reliable } } } });
  const planted = (over = {}) => spec.defects.map((d) => over[d.route] === undefined ? finding(d.method, d.route, 'warning') : over[d.route]).filter(Boolean);
  // runs: [{ planted: [...], clean: [...] }], one per run.
  const gate = (runs) => {
    rmSync(dir, { recursive: true, force: true });
    runs.forEach((x, k) => { for (const twin of ['planted', 'clean']) { mkdirSync(join(dir, `run${k + 1}`, 'L11-cold-start', twin), { recursive: true }); writeFileSync(join(dir, `run${k + 1}`, 'L11-cold-start', twin, 'report.json'), JSON.stringify({ schema: 'report/1', started: `run${k + 1}`, findings: x[twin] })); } });
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'compare-reports.js'), ...runs.map((_, k) => join(dir, `run${k + 1}`))], { encoding: 'utf8' });
    return { code: r.status, text: r.stdout + r.stderr };
  };
  const five = (f) => [0, 1, 2, 3, 4].map(f);
  const prices = finding('GET', '/prices/:id', 'info', false);
  const orders = finding('POST', '/orders', 'info', false);
  const all = gate(five(() => ({ planted: planted(), clean: [] })));
  ok('gate: five runs, every planted row a warning, nothing on a clean row: holds', all.code === 0 && /UNRELIABLE-COUNT  0 /.test(all.text) && /^IDENTICAL  2 report/m.test(all.text), all.text);
  const one = gate(five((k) => ({ planted: planted(), clean: k === 2 ? [prices] : [] })));
  ok('  an info "timing unreliable" on a clean row in one run: no difference; counted and printed with its row and run', one.code === 0 && /^UNRELIABLE-INFO  L11-cold-start\/clean\/report\.json: cold-start STB-10 GET \/prices\/:id in .*run3 /m.test(one.text) && /UNRELIABLE-COUNT  1 /.test(one.text), one.text);
  const decoyPlanted = gate(five((k) => ({ planted: k === 1 ? [...planted(), orders] : planted(), clean: [] })));
  ok('  the same on a decoy row of the planted twin: no difference', decoyPlanted.code === 0 && /UNRELIABLE-INFO  L11-cold-start\/planted\/report\.json: cold-start STB-10 POST \/orders/.test(decoyPlanted.text), decoyPlanted.text);
  const twice = gate(five((k) => ({ planted: planted(), clean: k === 1 || k === 3 ? [prices] : [] })));
  ok('  the same row in two of the five runs: fails', twice.code === 1 && /^UNRELIABLE-REPEATED  L11-cold-start\/clean\/report\.json: cold-start STB-10 GET \/prices\/:id: "timing unreliable" in 2 runs/m.test(twice.text), twice.text);
  const three = gate(five((k) => ({ planted: k === 4 ? [...planted(), orders] : planted(), clean: k === 4 ? [prices, finding('GET', '/checkout/countries', 'info', false)] : [] })));
  ok('  three in one run, on different rows: fails (at most two a run)', three.code === 1 && /^UNRELIABLE-RUN  .*run5: 3 "timing unreliable" infos/m.test(three.text) && !/^UNRELIABLE-REPEATED/m.test(three.text), three.text);
  const two = gate(five((k) => ({ planted: k === 4 ? [...planted(), orders] : planted(), clean: k === 4 ? [prices] : [] })));
  ok('  two in one run, on different rows: holds', two.code === 0, two.text);
  const plantedInfo = gate(five((k) => ({ planted: planted(k === 0 ? { '/regions/:postcode': finding('GET', '/regions/:postcode', 'info', false) } : {}), clean: [] })));
  ok('  a planted row reading "timing unreliable" in one run: fails', plantedInfo.code === 1 && /^PLANTED-UNRELIABLE  L11-cold-start\/planted\/report\.json: cold-start STB-10 GET \/regions\/:postcode reads "timing unreliable" in .*run1/m.test(plantedInfo.text), plantedInfo.text);
  const missing = gate(five((k) => ({ planted: planted(k === 3 ? { '/checkout/countries': null } : {}), clean: [] })));
  ok('  a planted row missing in one run: fails', missing.code === 1 && /^PLANTED-MISSING  L11-cold-start\/planted\/report\.json: cold-start STB-10 GET \/checkout\/countries has no error or warning in .*run4/m.test(missing.text), missing.text);
  const reported = gate(five((k) => ({ planted: planted(), clean: k === 0 ? [finding('GET', '/prices/:id', 'warning')] : [] })));
  ok('  a clean row reported as a warning in one run: fails', reported.code === 1 && /^DECOY-REPORTED  L11-cold-start\/clean\/report\.json: cold-start STB-10 GET \/prices\/:id is a warning in .*run1, a row with nothing planted/m.test(reported.text), reported.text);
  const fp = gate(five((k) => ({ planted: planted(k === 2 ? { '/regions/:postcode': { ...finding('GET', '/regions/:postcode', 'warning'), fingerprint: 'cold-start|other' } } : {}), clean: [] })));
  ok('  a planted row whose fingerprint differs in one run: fails as a difference', fp.code === 1 && /^DIFFERS  L11-cold-start\/planted\/report\.json/m.test(fp.text) && /fingerprint/.test(fp.text), fp.text);
  const info = gate(five((k) => ({ planted: planted(), clean: k === 2 ? [{ ...prices, erlang: { trace: { judge: 'starts', timing: { reliable: true } } } }] : [] })));
  ok('  an info on a clean row that is not "timing unreliable" is still a difference', info.code === 1 && /^DIFFERS  L11-cold-start\/clean\/report\.json/m.test(info.text), info.text);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\nLoad and headroom modes start (no module-order error)');
{
  // run.js dispatches load and headroom mode part way through the module, so
  // anything those modes read must be initialised by then (CI run
  // 44745932286: every load job stopped at "Cannot access 'TIMED_FORM'
  // before initialization"). With a stand-in k6 and no database server,
  // each mode must get as far as its first database call.
  const dir = join(OUT, 'mode-start');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'k6'), '#!/bin/sh\necho "k6 v0.0.0 (stand-in)"\n', { mode: 0o755 });
  writeFileSync(join(dir, 'pw'), 'x\n');
  for (const mode of ['--load', '--headroom']) {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'trace', 'run.js'), mode, 'fixtures/L09-blocking-work', join(dir, 'out'), join(dir, 'node_modules')], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, ERLANG_K6: join(dir, 'k6'), ERLANG_TRACE_CONTAINER: 'erlang-no-such-container', ERLANG_TRACE_PORT: '1', ERLANG_TRACE_APP_PASSWORD_FILE: join(dir, 'pw') } });
    const text = r.stdout + r.stderr;
    ok(`${mode} mode reaches its first database call, with no error from module order`, !/before initialization|is not defined/.test(text) && /psql/.test(text), text.slice(-600));
  }
}

console.log('\nHeadroom: the clean twin under 0.2 busy at every step');
{
  const out = join(OUT, 'headroom');
  const run = (busy) => {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'headroom.json'), JSON.stringify({ fixture: 'L09', form: 'express', twin: 'clean', n: 10, warm: 3, rows: [{ step: 'avatars', method: 'GET', path: '/avatars/1', rate: 20, ms: 0.5, background: { method: 'GET', path: '/export', rate: 6, ms: (busy - 0.01) * 1000 / 6 }, busy }] }));
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'headroom', 'judge.js'), 'fixtures/L09-blocking-work', out], { encoding: 'utf8' });
    return { code: r.status, text: (r.stdout + r.stderr).trim() };
  };
  const ok19 = run(0.19);
  ok('headroom: a clean twin busy 0.19 of the time at the step\'s rate passes, with the rate x ms line', ok19.code === 0 && /^HEADROOM  L09 express clean avatars: 20\/s x 0\.50 ms \(GET \/avatars\/1\) \+ 6\/s x .* = busy 0\.190 \(median of 1; max 0\.190\)$/m.test(ok19.text), ok19.text);
  const over = run(0.21);
  ok('  busy 0.21 fails the form (exit 1), naming the step', over.code === 1 && /busy 0\.210 \(median of 1; max 0\.210\): median over 0\.2/.test(over.text) && /^FAIL  L09 express headroom/m.test(over.text), over.text);
  {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'headroom.json'), JSON.stringify({ fixture: 'L05', form: 'express', twin: 'clean', n: 10, warm: 3, rows: [{ step: 'searchWarm', judged: false, method: 'GET', path: '/search', rate: 100, ms: 2.04, background: null, busy: 0.204 }, { step: 'searchProducts', judged: true, method: 'GET', path: '/search', rate: 100, ms: 1.12, background: null, busy: 0.112 }] }));
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'headroom', 'judge.js'), 'fixtures/L05-memory-growth', out], { encoding: 'utf8' });
    const text = r.stdout + r.stderr;
    ok('  an unjudged step (a warm-up) over 0.2 is printed with its figures and does not fail the form', r.status === 0 && /searchWarm: 100\/s x 2\.04 ms .* = busy 0\.204 \(median of 1; max 0\.204\) \(unjudged step: printed, not failed\)/.test(text) && /^PASS  L05 express headroom: .* at most 0\.112 of the time at any judged step's rate/m.test(text), text);
  }
  // The median rule (the owner, 20 November 2026): ten measurements a step.
  const each = (busyEach) => {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const sorted = [...busyEach].sort((a, b) => a - b);
    const busy = (sorted[4] + sorted[5]) / 2;
    writeFileSync(join(out, 'headroom.json'), JSON.stringify({ fixture: 'L09', form: 'express', twin: 'clean', n: 10, warm: 3, rows: [{ step: 'codes', judged: true, method: 'POST', path: '/codes', rate: 20, ms: busy * 50, background: null, busy, busyEach, each: busyEach.map((b) => ({ ms: b * 50, gcMs: b > 0.2 ? 30 : 0, gcs: b > 0.2 ? 1 : 0 })) }] }));
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'headroom', 'judge.js'), 'fixtures/L09-blocking-work', out], { encoding: 'utf8' });
    return { code: r.status, text: (r.stdout + r.stderr).trim() };
  };
  const stall = each([0.05, 0.05, 0.06, 0.05, 0.25, 0.05, 0.06, 0.05, 0.05, 0.05]);
  ok('  one measurement over 0.2 but under 0.3, the median 0.05: passes, the measurement printed with its collections', stall.code === 0 && /busy 0\.050 \(median of 10; max 0\.250\); collections 1, 30\.00 ms/.test(stall.text) && /codes measurements: busy \[.*0\.25.*\]; ms .*; collection ms \[0,0,0,0,30,/.test(stall.text), stall.text);
  const single = each([0.05, 0.05, 0.06, 0.05, 0.31, 0.05, 0.06, 0.05, 0.05, 0.05]);
  ok('  one measurement over 0.3 fails outright, though the median is 0.05', single.code === 1 && /: 1 measurement\(s\) over 0\.3/.test(single.text), single.text);
  const median = each([0.21, 0.22, 0.21, 0.19, 0.22, 0.21, 0.2, 0.22, 0.21, 0.21]);
  ok('  a median over 0.2 with no measurement over 0.3 fails', median.code === 1 && /: median over 0\.2$/m.test(median.text), median.text);
  rmSync(out, { recursive: true, force: true });
}

console.log('\nThe trace judge (memory), with no twin to compare against');
{
  // L05's trace form: each soak's heap after a full collection at each count;
  // a slope of KEPT_BYTES (512) a request or more with R² 0.9 or better is
  // reported, judged on the twin alone. Recorded shape; the numbers are those
  // of a local run and of CI run 44666936253's two noisy decoys.
  const form = join(OUT, 'trace-l05');
  rmSync(form, { recursive: true, force: true });
  for (const d of ['planted', 'clean', 'trace']) cpSync(join(ROOT, 'fixtures', 'L05-memory-growth', d), join(form, d), { recursive: true });
  const out = join(form, 'out');
  const spec = JSON.parse(readFileSync(join(form, 'trace', 'trace.json'), 'utf8'));
  // A soak whose heap rises by perReq a request from its first count on,
  // with a wobble of `noise` bytes in a pattern that leaves the slope as it
  // is and lowers only the fit (six counts a soak).
  const WOBBLE = [0, 1, -1, -1, -1, -1, 1];
  const soak = (r, perReq, noise = 0) => ({ id: r.id, method: r.method, route: r.route ?? r.path, points: [0, ...r.counts].map((n, k) => ({ requests: n, heapUsed: 10_000_000 + perReq * n + noise * (WOBBLE[k] ?? 0), collected: true, answered: n })) });
  const run = (per) => {
    rmSync(out, { recursive: true, force: true });
    for (const t of ['planted', 'clean']) {
      mkdirSync(join(out, t), { recursive: true });
      writeFileSync(join(out, t, 'raw.json'), JSON.stringify({ image: null, started: '2026-11-19T00:00:00Z', environment: { before: { load1: 6, cpus: 8 }, after: { load1: 6, cpus: 8 } }, fixture: 'L05', form: 'express', twin: t, seed: {}, scales: { 1: { n: 1, tables: {}, requests: [], pages: [], soaks: spec.soaks.map((r) => soak(r, ...per(t, r.id))) } } }));
    }
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'trace', 'judge.js'), form, out], { encoding: 'utf8' });
    return { code: r.status, text: (r.stdout + r.stderr).trim() };
  };
  // [bytes a request, wobble]: the local run (searchProducts 5,232, placeCart
  // 1,587, createOrder 83, all with R² 0.97 or better; the clean twin's
  // bounded suggestion cache 37 with R² 0.96), CI's two decoys (planted
  // /suggest 45 bytes a request at R² 0.22, clean /orders/:id/lines 97 at
  // 0.06), and a large slope on a poor fit (900 bytes a request, R² about 0.5).
  const local = (t, id) => (t === 'planted' ? { searchProducts: [5232, 5_000], suggest: [45, 14_500], createOrder: [83, 600], orderLines: [900, 60_000], placeCart: [1587, 5_000] } : { searchProducts: [8, 1_000], suggest: [37, 1_000], createOrder: [17, 1_000], orderLines: [97, 26_000], placeCart: [1, 1_000] })[id];
  const good = run(local);
  ok('memory: both real leaks reported, each twin judged alone; neither decoy, and nothing in the clean twin', good.code === 0 && /PASS  L05 express planted: 2\/2/.test(good.text) && /PASS  L05 express clean: 0/.test(good.text), good.text);
  ok('  the slope and its fit are printed for every soak, both twins; the two CI decoys fit under 0.9', /SOAK  L05 express planted suggest: 45\.0 B\/request, R² 0\.[0-8]\d \(/.test(good.text) && /SOAK  L05 express clean orderLines: 97\.0 B\/request, R² 0\.[0-8]\d \(/.test(good.text), good.text);
  ok('  a slope on a poor fit does not count, however large (900 bytes a request)', /SOAK  L05 express planted orderLines: 900\.0 B\/request, R² 0\.[0-8]\d \(6 points\)$/m.test(good.text), good.text);
  ok('  the real leaks fit at 0.9 or better and are reported', /SOAK  L05 express planted searchProducts: 5232\.0 B\/request, R² (0\.9\d|1\.00) \(6 points\), reported/.test(good.text) && /SOAK  L05 express planted placeCart: 1587\.0 B\/request, R² (0\.9\d|1\.00) \(6 points\), reported/.test(good.text), good.text);
  ok('  createOrder (83 bytes an order) stays the documented expected miss', /EXPECTED  L05 express planted: memory-growth STB-05 POST \/orders, below the detection floor .*not found, as documented/.test(good.text), good.text);
  const steady = run((t, id) => (t === 'clean' && id === 'suggest' ? [700] : local(t, id)));
  ok('  the same rule in the clean twin: a steady 700 bytes a request is reported there too', steady.code === 1 && /reported: memory-growth STB-05/.test(steady.text), steady.text);
  const same = run((t, id) => local('clean', id));
  ok('  the control: twins that keep alike give no finding, and both defects are missed', same.code === 1 && /missed memory-growth STB-05 GET \/search/.test(same.text) && /missed memory-growth STB-05 POST \/checkout/.test(same.text), same.text);
  rmSync(form, { recursive: true, force: true });
}

console.log('\nThe load judge: a static info left unresolved takes the load verdict');
{
  const form = join(OUT, 'load-l10');
  rmSync(form, { recursive: true, force: true });
  for (const d of ['planted', 'clean', 'load']) cpSync(join(ROOT, 'fixtures', 'L10-no-cache', d), join(form, d), { recursive: true });
  const out = join(form, 'out');
  const ids = [['orderTotals', '/stats'], ['orderLines', '/orders/:id/lines'], ['quote', '/checkout/quote'], ['categoryCount', '/stats/categories/:id'], ['customerOrders', '/stats/customers/:id'], ['refundTotals', '/stats/refunds'], ['exportReady', '/exports/:id/ready']];
  const step = (id, route, perRequest) => ({ id, method: 'GET', path: '/x', route, rate: 10, seconds: 10, interrupted: false, counts: { requests: 101, ok: 101, late: 0, refused: 0, failed: 0, dropped: 0 }, statements: { calls: Math.round(perRequest * 101) }, served: { medMs: 2, p90Ms: 3, p99Ms: 5, maxMs: 9 }, refusals: null, samples: [], environment: { before: { load1: 1.9, cpus: 2 }, after: { load1: 0.9, cpus: 2, cooledAfterS: 30 } } });
  const run = (planted) => {
    rmSync(out, { recursive: true, force: true });
    for (const t of ['planted', 'clean']) mkdirSync(join(out, t), { recursive: true });
    const clean = { orderTotals: 0.0099, orderLines: 2, quote: 2 };
    writeFileSync(join(out, 'raw.json'), JSON.stringify({ profile: 'ci', fixture: 'L10', form: 'express', repeats: [0, 1, 2].map(() => ({ planted: { steps: ids.map(([id, r]) => step(id, r, planted[id] ?? 1)) }, clean: { steps: ids.map(([id, r]) => step(id, r, clean[id] ?? 1)) } })) }));
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'load', 'judge.js'), form, out], { encoding: 'utf8' });
    return { code: r.status, text: r.stdout + r.stderr };
  };
  const good = run({ orderTotals: 1, orderLines: 6, quote: 3 });
  ok('L10: /stats, info statically (freshness unknown), is a warning once the load run counts a statement per request against the cached twin', good.code === 0 && /PASS  L10 express load planted: 3\/3/.test(good.text), good.text.split('\n').slice(0, 3).join('\n'));
  const cached = run({ orderTotals: 0.0099, orderLines: 6, quote: 3 });
  ok('  the control: a planted twin that caches /stats too leaves the static finding at info, and the defect is missed', cached.code === 1 && /missed no-cache step orderTotals/.test(cached.text), cached.text.split('\n')[0]);
  rmSync(form, { recursive: true, force: true });
}

console.log('\nThe warm-up before a start (cold-start)');
{
  const dir = join(OUT, 'warmup');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  ok('warm-up: none configured is the 404 fallback, which says so', JSON.stringify(warmupFor(null, dir)) === JSON.stringify({ source: 'fallback', method: 'GET', path: FALLBACK_WARMUP }));
  writeFileSync(join(dir, 'erlang.config.json'), JSON.stringify({ warmup: { path: '/health' } }));
  ok('  erlang.config.json "warmup" is used, GET by default', JSON.stringify(warmupFor(null, dir)) === JSON.stringify({ source: 'erlang.config.json', method: 'GET', path: '/health' }));
  ok('  a trace form\'s own warm-up route comes first', warmupFor({ path: '/__trace/warm' }, dir).source === 'trace.json');
  const bad = (cfg) => { writeFileSync(join(dir, 'erlang.config.json'), JSON.stringify(cfg)); try { warmupFor(null, dir); return false; } catch (e) { return /does not match/.test(e.message); } };
  ok('  a warm-up that is not a path on the app, or that could change something, is refused', bad({ warmup: { path: '//elsewhere/x' } }) && bad({ warmup: { path: 'health' } }) && bad({ warmup: { path: '/health', method: 'POST' } }) && bad({ warmup: {} }));
  writeFileSync(join(dir, 'erlang.config.json'), JSON.stringify({ warmup: { method: 'HEAD', path: '/health' } }));
  ok('  the static scan accepts a config with a warm-up', !scan(dir).reason && !scan(dir).findings.some((f) => /config/i.test(f.message ?? '')), JSON.stringify(scan(dir).reason ?? null));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\nTimed trace forms: unreliable is never a pass');
{
  // L11 (judge "starts", with a warm-up): each route's first-request extra
  // against the cheapest route's in the same process, five starts. Recorded
  // shape, synthetic numbers.
  const form = join(OUT, 'trace-l11');
  rmSync(form, { recursive: true, force: true });
  for (const d of ['planted', 'clean', 'trace']) cpSync(join(ROOT, 'fixtures', 'L11-cold-start', d), join(form, d), { recursive: true });
  const out = join(form, 'out');
  const routes = [['region', 'GET', '/regions/P123', '/regions/:postcode'], ['countries', 'GET', '/checkout/countries', '/checkout/countries'], ['invoicePdf', 'GET', '/invoices/1.pdf', '/invoices/:id.pdf'], ['price', 'GET', '/prices/1', '/prices/:id'], ['createOrder', 'POST', '/orders', '/orders']];
  const cold = { region: 300, countries: 115, invoicePdf: 230 };
  const raw = (twin, env, notCold = () => false) => ({ image: null, started: '2026-11-19T00:00:00Z', environment: env, fixture: 'L11', form: 'express', twin, seed: {}, scales: { 1: { n: 1, tables: {}, requests: [], pages: [],
    // Each start: a warm-up, then every route's first request in one process;
    // the extra is first minus the later median (1 ms), the baseline the
    // cheapest route's extra in that start.
    warmup: { source: 'fallback', method: 'GET', path: '/__erlang/warm-up-not-found', runs: [0, 1, 2, 3, 4].map(() => ({ status: 404, ms: 9 })) },
    starts: routes.map(([id, method, path, route]) => ({ id, method, path, route, samples: [0, 1, 2, 3, 4].map((k) => { const firstMs = (twin === 'planted' && cold[id] && !notCold(id, k) ? cold[id] : 5) + k; return { start: k, position: (routes.findIndex((r) => r[0] === id) - k + 5) % 5, warmupMs: 4 + k, firstMs, laterMs: [1, 1.1, 0.9, 1, 1.2], extraMs: firstMs - 1, baselineMs: 4 + k, baselineOf: 'warm-up' }; }) })) } } });
  const run = (env, notCold = () => false) => {
    rmSync(out, { recursive: true, force: true });
    for (const t of ['planted', 'clean']) { mkdirSync(join(out, t), { recursive: true }); writeFileSync(join(out, t, 'raw.json'), JSON.stringify(raw(t, env, notCold))); }
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'trace', 'judge.js'), form, out], { encoding: 'utf8' });
    return { code: r.status, text: (r.stdout + r.stderr).trim() };
  };
  const calm = run({ before: { load1: 0.5, cpus: 8 }, after: { load1: 0.5, cpus: 8 } });
  ok('starts on a calm machine: the three cold routes are failing findings, and the form passes (exit 0)', calm.code === 0 && /^PASS  L11 express planted: 3\/3/m.test(calm.text), calm.text);
  ok('  the report says which warm-up ran: the 404 fallback (a GET and a JSON POST to a random path), which warms the framework and its body parser but not the database driver', /^WARM-UP  L11 express planted: fallback, GET then POST with a small JSON body to \/__erlang\/warm-up-not-found and a random suffix, a path that does not exist \(the GET answered 404\): warms the framework and its body parser, not the database driver/m.test(calm.text) && /a 404: they warm the framework and its body parser, not the database driver/.test(calm.text + readFileSync(join(out, 'planted', 'report.json'), 'utf8')) && JSON.parse(readFileSync(join(out, 'planted', 'report.json'), 'utf8')).erlang.trace.warmup.source === 'fallback', calm.text);
  ok('  after the 404 fallback, the baseline is the 404 request\'s own time, and the finding says so', /against \d+ ms for the warm-up request itself, in the same process after requests to a path that does not exist \(GET, then POST with a small JSON body/.test(JSON.stringify(readdirSync(out).flatMap((t) => (existsSync(join(out, t, 'report.json')) ? [readFileSync(join(out, t, 'report.json'), 'utf8')] : [])))), calm.text);
  const busy = run({ before: { load1: 6, cpus: 8 }, after: { load1: 6, cpus: 8 } });
  ok('  the same run on a busy machine: still failing findings, the load averages recorded only (the relative rule)', busy.code === 0 && /^PASS  L11 express planted: 3\/3/m.test(busy.text), busy.text);
  const mixed = run({ before: { load1: 0.5, cpus: 8 }, after: { load1: 0.5, cpus: 8 } }, (id, k) => id === 'region' && k === 2);
  ok('  a start where a cold route did not clear: UNRELIABLE with samples and why, and short of the planted margin (exit 1), never SKIP or PASS', mixed.code === 1 && /^FAIL  L11 express planted: planted margin/m.test(mixed.text) && /^UNRELIABLE  L11 express planted: cold-start STB-10 GET \/regions\/:postcode: timing unreliable \(samples .*4 of 5 repeats cleared the threshold/m.test(mixed.text) && !/^PASS  L11 express planted/m.test(mixed.text), mixed.text);
  // Decoy margin: the clean twin's price at 10 ms over the baseline in one
  // start (half the 20 ms bar: kept), then at 12 (over half, and over half
  // the 3x ratio: the form fails, though nothing is reported).
  const nudge = (extra, at = [2]) => {
    rmSync(out, { recursive: true, force: true });
    for (const t of ['planted', 'clean']) {
      const r = raw(t, { before: { load1: 0.5, cpus: 8 }, after: { load1: 0.5, cpus: 8 } });
      if (t === 'clean') for (const i of at) { const q = r.scales[1].starts.find((x) => x.id === 'price').samples[i]; q.extraMs = q.baselineMs + extra; q.firstMs = q.extraMs + 1; }
      mkdirSync(join(out, t), { recursive: true });
      writeFileSync(join(out, t, 'raw.json'), JSON.stringify(r));
    }
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'trace', 'judge.js'), form, out], { encoding: 'utf8' });
    return { code: r.status, text: (r.stdout + r.stderr).trim() };
  };
  const half = nudge(10);
  ok('  decoy margin: a clean decoy 10 ms over the baseline, half the bar, keeps its margin', half.code === 0 && /^DECOY  L11 express clean GET \/prices\/:id: ms over the baseline \[0,0,10,0,0\]/m.test(half.text) && !/OVER/.test(half.text), half.text);
  // Planted margin: the planted region route 30 ms over the baseline in one
  // start (over the 20 ms bar, under twice it: found, and the form fails),
  // then 60 (twice the bar and over twice the 3x ratio: kept).
  const planted = (extra, at = [2]) => {
    rmSync(out, { recursive: true, force: true });
    for (const t of ['planted', 'clean']) {
      const r = raw(t, { before: { load1: 0.5, cpus: 8 }, after: { load1: 0.5, cpus: 8 } });
      if (t === 'planted') for (const i of at) { const q = r.scales[1].starts.find((x) => x.id === 'region').samples[i]; q.extraMs = q.baselineMs + extra; q.firstMs = q.extraMs + 1; }
      mkdirSync(join(out, t), { recursive: true });
      writeFileSync(join(out, t, 'raw.json'), JSON.stringify(r));
    }
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'trace', 'judge.js'), form, out], { encoding: 'utf8' });
    return { code: r.status, text: (r.stdout + r.stderr).trim() };
  };
  // The median rule (the owner, 20 November 2026): one sample past the
  // margin but inside the bar is an outlier, printed, not failed; the median
  // past the margin fails; one sample past the judge's bar fails.
  const short = planted(30);
  ok('  planted margin: one start 30 ms over the baseline (over the 20 ms bar, under twice it) is an OUTLIER, printed with its diagnostics, not failed', short.code === 0 && /^PASS  L11 express planted: 3\/3/m.test(short.text) && /^OUTLIER  L11 express planted GET \/regions\/:postcode: sample 3 short of the planted margin but clearing the bar \(not failed\): .*"load1":.*"laterMedianMs":1,"gcs":.*"db":/m.test(short.text) && !/planted margin/.test(short.text.split('\n').filter((l) => l.startsWith('FAIL')).join('\n')), short.text);
  const shortMedian = planted(30, [0, 1, 2]);
  ok('  three starts of five 30 ms over the baseline: short on the median, the form fails', shortMedian.code === 1 && /^PLANTED  L11 express planted GET \/regions\/:postcode: .*SHORT on the median/m.test(shortMedian.text) && /^FAIL  L11 express planted: planted margin  \(GET \/regions\/:postcode: the median cleared its bar by less than 2x\)/m.test(shortMedian.text), shortMedian.text);
  const below = planted(10);
  ok('  one start 10 ms over the baseline, under the judge\'s bar: fails outright, whatever the median', below.code === 1 && /BELOW THE BAR in sample\(s\) 3/.test(below.text) && /^FAIL  L11 express planted: planted margin  \(GET \/regions\/:postcode: 1 sample\(s\) below the judge's bar\)/m.test(below.text), below.text);
  const wide = planted(60);
  ok('  at 60 ms over the baseline every condition clears by 2x, and the form passes', wide.code === 0 && /^PLANTED  L11 express planted GET \/regions\/:postcode: ms over the baseline \[\d+,\d+,60,/m.test(wide.text) && !/SHORT|OUTLIER/.test(wide.text), wide.text);
  const over = nudge(12);
  ok('  decoy margin: one start 12 ms over the baseline (over half the bar and half the ratio, inside the bar) is an OUTLIER, not failed', over.code === 0 && /^OUTLIER  L11 express clean GET \/prices\/:id: sample 3 past the decoy margin but inside the bar \(not failed\)/m.test(over.text) && /^PASS  L11 express clean: 0 error/m.test(over.text), over.text);
  const overMedian = nudge(12, [0, 1, 2]);
  ok('  three starts of five 12 ms over the baseline: over on the median, the form fails with nothing reported', overMedian.code === 1 && /^FAIL  L11 express clean: decoy margin  \(GET \/prices\/:id: the median reached half the bar on every condition\)/m.test(overMedian.text) && /^PASS  L11 express clean: 0 error/m.test(overMedian.text), overMedian.text);
  const reached = nudge(25);
  ok('  one start 25 ms over the baseline, past the judge\'s bar: fails outright', reached.code === 1 && /REACHED THE BAR in sample\(s\) 3/.test(reached.text) && /^FAIL  L11 express clean: decoy margin  \(GET \/prices\/:id: 1 sample\(s\) reached the judge's bar\)/m.test(reached.text), reached.text);
  rmSync(form, { recursive: true, force: true });
}

console.log('\nThe edit unit (shared with ITTEN and KERCKHOFFS)');
{
  const dir = join(OUT, 'edit-unit');
  const fresh = (files) => { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); } };
  const read = (f) => readFileSync(join(dir, f), 'utf8');
  const refused = (what, files, edits, re) => { fresh(files); let threw = ''; try { apply(dir, [{ kind: 'auto', edits }]); } catch (e) { threw = e.message; } ok(`apply refuses ${what}`, re.test(threw) && Object.entries(files).every(([f, t]) => read(f) === t), threw || 'it did not throw'); };
  // Columns and lengths in UTF-16 code units: the emoji before the edit is
  // two units, the é one.
  fresh({ 'a.js': "const s = '😀é'; f(x);\n" });
  apply(dir, [{ kind: 'auto', edits: [{ file: 'a.js', line: 1, column: 20, length: 1, replace: 'y' }] }]);
  ok('a column counts UTF-16 code units (an emoji is two)', read('a.js') === "const s = '😀é'; f(y);\n", read('a.js'));
  fresh({ 'a.js': "const s = '😀';\n" });
  apply(dir, [{ kind: 'auto', edits: [{ file: 'a.js', line: 1, column: 12, length: 2, replace: 'ok' }] }]);
  ok('a length counts UTF-16 code units', read('a.js') === "const s = 'ok';\n", read('a.js'));
  fresh({ 'a.js': 'a();\r\nb();\r\n' });
  apply(dir, [{ kind: 'auto', edits: [{ file: 'a.js', line: 2, column: 1, length: 1, replace: 'c' }] }]);
  ok('lines are 1-based, CRLF files included', read('a.js') === 'a();\r\nc();\r\n', JSON.stringify(read('a.js')));
  fresh({ 'a.js': 'a();\n' });
  apply(dir, [{ kind: 'auto', edits: [{ create: 'db/002_index.sql', content: 'create index on t (a);\n' }] }]);
  ok('{ create, content } makes a file, and its directories', read('db/002_index.sql') === 'create index on t (a);\n');
  apply(dir, [{ kind: 'auto', edits: [{ remove: 'a.js' }] }]);
  ok('{ remove } deletes a file', !existsSync(join(dir, 'a.js')));
  refused('a create of a file that exists', { 'a.js': 'a();\n' }, [{ create: 'a.js', content: 'b();\n' }], /already exists/);
  refused('a remove of a file that does not exist', { 'a.js': 'a();\n' }, [{ remove: 'b.js' }], /does not exist/);
  refused('an edit to a file that does not exist (create makes files)', { 'a.js': 'a();\n' }, [{ file: 'b.js', line: 1, column: 1, length: 0, replace: 'x' }], /does not exist; a new file is made with \{ create, content \}/);
  refused('a path outside the project root', { 'a.js': 'a();\n' }, [{ file: '../a.js', line: 1, column: 1, length: 0, replace: 'x' }], /not a path relative to the project root/);
  refused('an absolute path', { 'a.js': 'a();\n' }, [{ file: join(dir, 'a.js'), line: 1, column: 1, length: 0, replace: 'x' }], /not a path relative to the project root/);
  refused('a line past the end', { 'a.js': 'a();\n' }, [{ file: 'a.js', line: 3, column: 1, length: 0, replace: 'x' }], /not 3/);
  refused('a column past the end of its line', { 'a.js': 'a();\nb();\n' }, [{ file: 'a.js', line: 1, column: 6, length: 0, replace: 'x' }], /no column 6/);
  refused('a length past the end of the file', { 'a.js': 'a();\n' }, [{ file: 'a.js', line: 1, column: 1, length: 9, replace: 'x' }], /past the end/);
  refused('a 0-based line or column', { 'a.js': 'a();\n' }, [{ file: 'a.js', line: 0, column: 0, length: 0, replace: 'x' }], /malformed/);
  refused('a file both edited and removed, changing nothing', { 'a.js': 'a();\n', 'b.js': 'b();\n' }, [{ file: 'b.js', line: 1, column: 1, length: 1, replace: 'c' }, { file: 'a.js', line: 1, column: 1, length: 0, replace: 'x' }, { remove: 'a.js' }], /edited and removed/);
  // Symbolic links: a directory link out of the root, a file link, and a
  // dangling link where a file would be created.
  const outside = join(OUT, 'edit-unit-outside');
  rmSync(outside, { recursive: true, force: true }); mkdirSync(outside, { recursive: true }); writeFileSync(join(outside, 'x.js'), 'x();\n');
  const linked = (what, make, edits, re) => { fresh({ 'a.js': 'a();\n' }); make(); let threw = ''; try { apply(dir, [{ kind: 'auto', edits }]); } catch (e) { threw = e.message; } ok(`apply refuses ${what}`, re.test(threw) && readFileSync(join(outside, 'x.js'), 'utf8') === 'x();\n' && !existsSync(join(outside, 'new.sql')), threw || 'it did not throw'); };
  linked('a create through a directory link out of the root', () => symlinkSync(outside, join(dir, 'db'), 'dir'), [{ create: 'db/new.sql', content: 'x' }], /outside the project root/);
  linked('an edit through a directory link out of the root', () => symlinkSync(outside, join(dir, 'db'), 'dir'), [{ file: 'db/x.js', line: 1, column: 1, length: 1, replace: 'y' }], /outside the project root/);
  linked('a remove through a directory link out of the root', () => symlinkSync(outside, join(dir, 'db'), 'dir'), [{ remove: 'db/x.js' }], /outside the project root/);
  linked('a create over a dangling link', () => symlinkSync(join(outside, 'new.sql'), join(dir, 'new.sql')), [{ create: 'new.sql', content: 'x' }], /symbolic link|outside the project root/);
  linked('an edit of a file that is a link', () => symlinkSync(join(dir, 'a.js'), join(dir, 'b.js')), [{ file: 'b.js', line: 1, column: 1, length: 1, replace: 'y' }], /symbolic link/);
  rmSync(outside, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

console.log('\nn-plus-one and per-row-writes: handlers, versions and shapes');
{
  const DB = ['n-plus-one', 'per-row-writes'];
  const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;
  const PRISMA = "import { PrismaClient } from '@prisma/client';\nexport const prisma = new PrismaClient();\n";
  const P7 = JSON.stringify({ dependencies: { '@prisma/client': '7.10.1' } });
  const P8 = JSON.stringify({ dependencies: { '@prisma/client': '8.0.0' } });
  const express = (body) => `import express from 'express';\nimport { prisma } from './db.js';\nconst app = express();\n${body}`;

  const next = "import { prisma } from '../../../../db.js';\nexport async function GET(request, { params }) {\n  const items = await prisma.lineItem.findMany({ where: { orderId: Number(params.id) } });\n  for (const item of items) item.product = await prisma.product.findUnique({ where: { id: item.productId } });\n  return Response.json(items);\n}\n";
  const r1 = expectFindings('Next.js app route: an awaited findUnique per item is an error, with the route from the folders', {
    'db.js': PRISMA, 'package.json': P7, 'app/orders/[id]/items/route.ts': next,
  }, [['error', 'app/orders/[id]/items/route.ts', 4, 'guided']], DB);
  ok('  its endpoint is GET /orders/:id/items', JSON.stringify(r1.findings[0]?.where.endpoints) === JSON.stringify([{ method: 'GET', route: '/orders/:id/items' }]), JSON.stringify(r1.findings[0]?.where.endpoints));

  const server = "import http from 'node:http';\nimport pg from 'pg';\nconst pool = new pg.Pool();\nhttp.createServer(async (req, res) => {\n  const { rows } = await pool.query('select id from orders limit 50');\n  for (const o of rows) await pool.query('select * from items where order_id = $1', [o.id]);\n  res.end();\n}).listen(3000);\n";
  const r2 = expectFindings('node:http request handler: a pg query per row is an error, with no endpoint', { 'server.js': server }, [['error', 'server.js', 6, 'guided']], DB);
  ok('  no endpoint, since node:http has no route', !r2.findings[0]?.where.endpoints);

  const job = "import { prisma } from './db.js';\nexport async function nightly() {\n  const orders = await prisma.order.findMany();\n  for (const o of orders) await prisma.customer.findUnique({ where: { id: o.customerId } });\n}\n";
  const r3 = expectFindings('No handler found anywhere: the finding is info, and says why', { 'db.js': PRISMA, 'package.json': P7, 'jobs.js': job }, [['info', 'jobs.js', 4, 'guided']], DB);
  ok('  it is marked unresolved and names erlang.config.json', r3.findings[0]?.erlang.unresolved === true && /erlang\.config\.json/.test(r3.findings[0]?.message ?? ''));
  const r4 = expectFindings('The same function named as a handler in erlang.config.json: an error, at its method and route', {
    'db.js': PRISMA, 'package.json': P7, 'jobs.js': job,
    'erlang.config.json': JSON.stringify({ handlers: [{ file: 'jobs.js', function: 'nightly', method: 'RUN', route: 'nightly-totals' }] }),
  }, [['error', 'jobs.js', 4, 'guided']], DB);
  ok('  its endpoint is the brief\'s', JSON.stringify(r4.findings[0]?.where.endpoints) === JSON.stringify([{ method: 'RUN', route: 'nightly-totals' }]));
  const r5 = expectFindings('A brief entry that names no function is a note, not an error', {
    'db.js': PRISMA, 'jobs.js': job, 'erlang.config.json': JSON.stringify({ handlers: [{ file: 'jobs.js', function: 'hourly' }] }),
  }, [['info', 'jobs.js', 4, 'guided']], DB);
  ok('  the note names the entry', JSON.stringify(r5.erlang?.checks?.['n-plus-one+per-row-writes']?.notes ?? []).includes('hourly'), JSON.stringify(r5.erlang?.checks?.['n-plus-one+per-row-writes']?.notes));

  const together = express("app.get('/orders', async (req, res) => {\n  const orders = await prisma.order.findMany({ take: 50 });\n  res.json(await Promise.all(orders.map((o) => prisma.customer.findUnique({ where: { id: o.customerId } }))));\n});\n");
  expectFindings('Prisma 7: findUnique per item, started together, is one query and not reported', { 'db.js': PRISMA, 'package.json': P7, 'app.js': together }, [], DB);
  const r6 = expectFindings('Prisma 8 (from package.json): the same code is an error, since 8 drops the batching', { 'db.js': PRISMA, 'package.json': P8, 'app.js': together }, [['error', 'app.js', 6, 'guided']], DB);
  ok('  the message says Prisma 8 does not batch', /Prisma 8\.0\.0 does not batch/.test(r6.findings[0]?.message ?? ''), r6.findings[0]?.message);
  expectFindings('Prisma 8 from package-lock.json wins over a 7 range in package.json', {
    'db.js': PRISMA, 'package.json': P7, 'package-lock.json': JSON.stringify({ packages: { 'node_modules/@prisma/client': { version: '8.0.1' } } }), 'app.js': together,
  }, [['error', 'app.js', 6, 'guided']], DB);
  const awaitFirst = express("app.get('/orders', async (req, res) => {\n  const orders = await prisma.order.findMany({ take: 50 });\n  res.json(await Promise.all(orders.map(async (o) => {\n    const fx = await fetch(`https://fx.internal/${o.currency}`, { signal: AbortSignal.timeout(1000) });\n    return { fx: await fx.json(), customer: await prisma.customer.findUnique({ where: { id: o.customerId } }) };\n  })));\n});\n");
  expectFindings('An unrelated await before findUnique in the callback: info, since the calls may not start together', { 'db.js': PRISMA, 'package.json': P7, 'app.js': awaitFirst }, [['info', 'app.js', 8, 'guided']], DB);

  const counts = express("app.post('/events', async (req, res) => {\n  for (const key of ['a', 'b', 'c']) await prisma.setting.findUnique({ where: { key } });\n  for (let i = 0; i < 1000; i++) await prisma.event.create({ data: { n: i } });\n  res.end();\n});\n");
  const r7 = expectFindings('A fixed list of three is not reported; a loop to 1000 in a handler is', { 'db.js': PRISMA, 'package.json': P7, 'app.js': counts }, [['warning', 'app.js', 6, 'guided']], DB);
  ok('  the list is a fixed count of 1000', r7.findings[0]?.erlang.over === 'fixed count' && /1000 iterations/.test(r7.findings[0]?.message ?? ''));

  const passed = "import Fastify from 'fastify';\nimport pg from 'pg';\nconst pool = new pg.Pool();\nasync function productOf(item) {\n  return (await pool.query('select * from products where id = $1', [item.productId])).rows[0];\n}\nconst app = Fastify();\napp.get('/orders/:id/items', async function items(request) {\n  const { rows } = await pool.query('select * from line_items where order_id = $1', [request.params.id]);\n  return Promise.all(rows.map(productOf));\n});\n";
  const r8 = expectFindings('A helper passed by name to map: reported at the map, with the query in the helper', { 'app.js': passed }, [['error', 'app.js', 10, 'guided']], DB);
  ok('  both places are named', JSON.stringify(r8.findings[0]?.where.locations.map((l) => l.line)) === JSON.stringify([10, 5]));

  const tx = express("app.post('/import', async (req, res) => {\n  await prisma.$transaction(async (tx) => {\n    for (const row of req.body.rows) await tx.order.create({ data: row });\n  });\n  res.end();\n});\n");
  expectFindings('The client an interactive $transaction passes in is Prisma too: create per row, auto', { 'db.js': PRISMA, 'package.json': P7, 'app.js': tx }, [['warning', 'app.js', 6, 'auto']], DB);
  expectAutoFixHolds('  its createMany fix holds', { 'db.js': PRISMA, 'package.json': P7, 'app.js': tx }, DB);
  const nested = express("app.post('/import', async (req, res) => {\n  for (const o of req.body.orders) await prisma.order.create({ data: { total: o.total, items: { create: o.items } } });\n  res.end();\n});\n");
  expectFindings('A create with a nested write is not turned into createMany, which cannot nest: guided', { 'db.js': PRISMA, 'package.json': P7, 'app.js': nested }, [['warning', 'app.js', 5, 'guided']], DB);
  const differ = express("app.put('/prices', async (req, res) => {\n  for (const p of req.body.prices) await prisma.product.update({ where: { id: p.id }, data: { price: p.price } });\n  res.end();\n});\n");
  expectFindings('An update whose data differs per row cannot be one updateMany: guided', { 'db.js': PRISMA, 'package.json': P7, 'app.js': differ }, [['warning', 'app.js', 5, 'guided']], DB);
  const del = express("app.post('/logout-all', async (req, res) => {\n  for (const id of req.body.sessions) await prisma.session.delete({ where: { id } });\n  res.end();\n});\n");
  expectAutoFixHolds('delete per id in a for loop: one deleteMany, and the fix holds', { 'db.js': PRISMA, 'package.json': P7, 'app.js': del }, DB);
  const sqlFor = "import Fastify from 'fastify';\nimport pg from 'pg';\nimport { sqlFor } from './sql.js';\nconst pool = new pg.Pool();\nconst app = Fastify();\napp.post('/counts', async function counts(request) {\n  for (const t of request.body.tables) await pool.query(sqlFor(t));\n});\n";
  expectFindings('A pg statement built at run time: read or write is unknown, so info under n-plus-one', { 'app.js': sqlFor }, [['info', 'app.js', 7, 'guided']], DB);
}

console.log('\nunbounded-query: sinks, caps and statements');
{
  const UQ = ['unbounded-query'];
  const PRISMA = "import { PrismaClient } from '@prisma/client';\nexport const prisma = new PrismaClient();\n";
  const next = "import { prisma } from '../../db.js';\nexport async function GET() {\n  const events = await prisma.event.findMany();\n  return Response.json(events);\n}\n";
  expectFindings('Next.js route returning Response.json(rows) of a findMany with no take: error', { 'db.js': PRISMA, 'app/events/route.ts': next }, [['error', 'app/events/route.ts', 3, 'guided']], UQ);
  const http = "import http from 'node:http';\nimport pg from 'pg';\nconst pool = new pg.Pool();\nhttp.createServer(async (req, res) => {\n  const { rows } = await pool.query('select * from events');\n  res.end(JSON.stringify(rows));\n}).listen(3000);\n";
  expectFindings('node:http: rows written with res.end(JSON.stringify(rows)): error', { 'server.js': http }, [['error', 'server.js', 5, 'guided']], UQ);
  const fastify = (body) => `import Fastify from 'fastify';\nimport pg from 'pg';\nconst pool = new pg.Pool();\nconst app = Fastify();\n${body}`;
  expectFindings('A LIMIT interpolated from the query string with no cap: error, auto', { 'app.js': fastify("app.get('/e', async function e(request) {\n  return (await pool.query(`select * from events limit ${request.query.n}`)).rows;\n});\n") }, [['error', 'app.js', 6, 'auto']], UQ);
  expectAutoFixHolds('  the cap applied to the interpolated value holds', { 'app.js': fastify("app.get('/e', async function e(request) {\n  return (await pool.query(`select * from events limit ${request.query.n}`)).rows;\n});\n") }, UQ);
  expectFindings('A page size through a helper that clamps with a comparison is capped', { 'app.js': fastify("const pageOf = (n) => (Number(n) > 100 ? 100 : Number(n) || 20);\napp.get('/e', async function e(request) {\n  return (await pool.query('select * from events limit $1', [pageOf(request.query.n)])).rows;\n});\n") }, [], UQ);
  expectFindings('A page size behind a conditional cap is capped', { 'app.js': fastify("app.get('/e', async function e(request) {\n  const n = Number(request.query.n);\n  const size = n > 100 ? 100 : n;\n  return (await pool.query('select * from events limit $1', [size])).rows;\n});\n") }, [], UQ);
  expectFindings('FETCH FIRST 20 ROWS ONLY is a limit', { 'app.js': fastify("app.get('/e', async function e() {\n  return (await pool.query('select * from events order by id fetch first 20 rows only')).rows;\n});\n") }, [], UQ);
  expectFindings('json_agg packs every row into one: its rows[0] sent is every row, an error', { 'app.js': fastify("app.get('/e', async function e() {\n  return (await pool.query('select json_agg(e) as all from events e')).rows[0];\n});\n") }, [['error', 'app.js', 6, 'guided']], UQ);
  expectFindings('count(*) with GROUP BY returns a row per group: reported', { 'app.js': fastify("app.get('/e', async function e() {\n  return (await pool.query('select kind, count(*) from events group by kind')).rows;\n});\n") }, [['error', 'app.js', 6, 'guided']], UQ);
  expectFindings('A statement built at run time is not judged', { 'app.js': fastify("import { sqlFor } from './sql.js';\napp.get('/e', async function e(request) {\n  return (await pool.query(sqlFor(request.query.t))).rows;\n});\n") }, [], UQ);
  const express = (body) => `import express from 'express';\nimport { prisma } from './db.js';\nconst app = express();\n${body}`;
  expectFindings('findMany with a range filter on the key is not bounded by it', { 'db.js': PRISMA, 'app.js': express("app.get('/e', async (req, res) => {\n  res.json(await prisma.event.findMany({ where: { id: { gt: Number(req.query.after) } } }));\n});\n") }, [['error', 'app.js', 5, 'guided']], UQ);
  expectFindings('findMany options spread from code ERLANG cannot read are not judged', { 'db.js': PRISMA, 'app.js': express("import { listOptions } from 'shared-config';\napp.get('/e', async (req, res) => {\n  res.json(await prisma.event.findMany({ ...listOptions }));\n});\n") }, [], UQ);
  expectFindings('Rows whose length alone is sent: a warning, not an error', { 'db.js': PRISMA, 'app.js': express("app.get('/e', async (req, res) => {\n  const all = await prisma.event.findMany();\n  res.json({ total: all.length });\n});\n") }, [['warning', 'app.js', 5, 'guided']], UQ);
  const job = "import { prisma } from './db.js';\nexport async function report() {\n  return prisma.event.findMany();\n}\n";
  expectFindings('No handler found: info', { 'db.js': PRISMA, 'jobs.js': job }, [['info', 'jobs.js', 3, 'guided']], UQ);
  expectFindings('A table named in smallTables is not reported', { 'db.js': PRISMA, 'erlang.config.json': JSON.stringify({ smallTables: ['Country'] }), 'app.js': express("app.get('/c', async (req, res) => {\n  res.json(await prisma.country.findMany());\n});\n") }, [], UQ);
}

console.log('\npool-sizing: deployments, limits and lifetimes');
{
  const { parseYaml } = await import('../lib/yaml.js');
  const [doc] = parseYaml('services:\n  api:\n    image: "postgres:16"   # the db\n    command: ["postgres", "-c", "max_connections=300"]\n    environment:\n      URL: postgres://db:5432/x\n');
  ok('YAML: quoted scalars, flow lists, comments, a colon inside a value, the line of each key', doc.services.api.image === 'postgres:16' && doc.services.api.command[2] === 'max_connections=300' && doc.services.api.environment.URL === 'postgres://db:5432/x' && doc.services.api.$lines.command === 4, JSON.stringify(doc));
  const long = `a${' '.repeat(200_000)}b\nkey: ${'x:'.repeat(100_000)}\n`;
  const t0 = Date.now();
  parseYaml(long);
  ok('YAML: a 200 kB line with no key, and one with 100,000 colons, read in linear time', Date.now() - t0 < 500, `${Date.now() - t0} ms`);
}
{
  const PS = ['pool-sizing'];
  const pg = (max) => `import pg from 'pg';\nexport const pool = new pg.Pool(${max === null ? '' : `{ ${max} }`});\n`;
  const server = "import Fastify from 'fastify';\nimport { pool } from './db.js';\nconst app = Fastify();\napp.get('/x', async function x() { return (await pool.query('select 1')).rows; });\napp.listen({ port: 3000 });\n";
  const compose = (api, db = 'image: postgres:16') => `services:\n  api:\n    build: .\n${api}  db:\n    ${db}\n`;
  expectFindings('Compose replicas × pool max within max_connections: nothing', { 'src/db.js': pg('max: 20'), 'src/server.js': server, 'docker-compose.yml': compose('    command: node src/server.js\n    deploy:\n      replicas: 4\n') }, [], PS);
  expectFindings('A pool with no max (pg default 10) past the limit: error, max inserted', { 'src/db.js': pg('connectionString: process.env.DATABASE_URL'), 'src/server.js': server, 'docker-compose.yml': compose('    command: node src/server.js\n    deploy:\n      replicas: 12\n') }, [['error', 'src/db.js', 2, 'auto']], PS);
  expectAutoFixHolds('  max: 8 inserted: 12 × 8 = 96 of 97', { 'src/db.js': pg('connectionString: process.env.DATABASE_URL'), 'src/server.js': server, 'docker-compose.yml': compose('    command: node src/server.js\n    deploy:\n      replicas: 12\n') }, PS);
  expectFindings('Dockerfile CMD npm start, through package.json, to the entry', { 'src/db.js': pg('max: 40'), 'src/server.js': server, 'package.json': JSON.stringify({ scripts: { start: 'node src/server.js' } }), 'Dockerfile': 'FROM node:22\nCOPY . .\nCMD ["npm", "start"]\n', 'docker-compose.yml': compose('    deploy:\n      replicas: 3\n') }, [['error', 'src/db.js', 2, 'auto']], PS);
  expectFindings('PM2 instances max: the count is unknown, but 2 × 60 already passes 97: error, unresolved, guided', { 'src/db.js': pg('max: 60'), 'src/server.js': server, 'ecosystem.config.cjs': "module.exports = { apps: [{ name: 'api', script: 'src/server.js', instances: 'max' }] };\n", 'docker-compose.yml': compose('    command: pm2-runtime ecosystem.config.cjs\n    deploy:\n      replicas: 2\n') }, [['error', 'src/db.js', 2, 'guided']], PS);
  expectFindings('node:cluster in the entry: the count is unknown and the floor fits: info', { 'src/db.js': pg('max: 10'), 'src/server.js': "import cluster from 'node:cluster';\n" + server, 'docker-compose.yml': compose('    command: node src/server.js\n') }, [['info', 'src/db.js', 2, 'guided']], PS);
  expectFindings('A PgBouncer service in front: info, the database limit is not what the pools meet', { 'src/db.js': pg('max: 50'), 'src/server.js': server, 'docker-compose.yml': compose('    command: node src/server.js\n    deploy:\n      replicas: 4\n  bouncer:\n    image: edoburu/pgbouncer:1.23\n') }, [['info', 'src/db.js', 2, 'guided']], PS);
  expectFindings('max_connections raised on the db service: 4 × 50 within 297', { 'src/db.js': pg('max: 50'), 'src/server.js': server, 'docker-compose.yml': compose('    command: node src/server.js\n    deploy:\n      replicas: 4\n', 'image: postgres:16\n    command: ["postgres", "-c", "max_connections=300"]') }, [], PS);
  const k8s = (replicas) => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: ${replicas}\n  template:\n    spec:\n      containers:\n        - name: api\n          image: example.test/api:1\n          command: ["node", "src/server.js"]\n`;
  expectFindings('Kubernetes with no limit in the repository: info', { 'src/db.js': pg('max: 10'), 'src/server.js': server, 'k8s/api.yaml': k8s(3) }, [['info', 'src/db.js', 2, 'guided']], PS);
  expectFindings('  the limit named in erlang.config.json: 3 × 10 within 97, nothing', { 'src/db.js': pg('max: 10'), 'src/server.js': server, 'k8s/api.yaml': k8s(3), 'erlang.config.json': JSON.stringify({ database: { maxConnections: 100 } }) }, [], PS);
  expectFindings('Helm-templated replicas are unknown: info', { 'src/db.js': pg('max: 10'), 'src/server.js': server, 'k8s/api.yaml': k8s('"{{ .Values.replicas }}"'), 'erlang.config.json': JSON.stringify({ database: { maxConnections: 100 } }) }, [['info', 'src/db.js', 2, 'guided']], PS);
  expectFindings('A pool from a max ERLANG cannot read (an env variable): info', { 'src/db.js': pg('max: Number(process.env.PG_MAX)'), 'src/server.js': server, 'docker-compose.yml': compose('    command: node src/server.js\n') }, [['info', 'src/db.js', 2, 'guided']], PS);
  expectFindings('vercel.json: instances unbounded, info', { 'src/db.js': pg('max: 5'), 'src/server.js': server, 'vercel.json': '{}' }, [['info', 'src/db.js', 2, 'guided']], PS);
  expectFindings('No deployment file: nothing to count', { 'src/db.js': pg('max: 500'), 'src/server.js': server }, [], PS);
  const handler = (body) => `import Fastify from 'fastify';\nimport pg from 'pg';\nconst app = Fastify();\nlet cached;\n${body}\napp.listen({ port: 3000 });\n`;
  expectFindings('A pool kept in a module variable on first use (if (!x) x = ...) is not per request', { 'src/server.js': handler("app.get('/x', async function x() {\n  if (!cached) cached = new pg.Pool({ max: 2 });\n  return (await cached.query('select 1')).rows;\n});") }, [], PS);
  expectFindings('A pool kept on globalThis is not per request', { 'src/server.js': handler("app.get('/x', async function x() {\n  const pool = (globalThis.pool ??= new pg.Pool({ max: 2 }));\n  return (await pool.query('select 1')).rows;\n});") }, [], PS);
  expectFindings('A pool returned by a factory each handler calls: per request', { 'src/server.js': handler("function makePool() {\n  return new pg.Pool({ max: 2 });\n}\napp.get('/x', async function x() {\n  return (await makePool().query('select 1')).rows;\n});") }, [['error', 'src/server.js', 6, 'guided']], PS);
  expectFindings('A pg Client per request, ended in finally: still per request', { 'src/server.js': handler("app.get('/x', async function x() {\n  const c = new pg.Client();\n  await c.connect();\n  try { return (await c.query('select 1')).rows; } finally { await c.end(); }\n});") }, [['error', 'src/server.js', 6, 'guided']], PS);
}

console.log('\nretry-policy: libraries and loops');
{
  const RP = ['retry-policy'];
  const fastify = (head, body) => `import Fastify from 'fastify';\n${head}\nconst app = Fastify();\n${body}\napp.listen({ port: 3000 });\n`;
  const route = (call) => `app.get('/x', async function x() {\n  return ${call};\n});`;
  const axr = (args) => fastify(`import axios from 'axios';\nimport axiosRetry from 'axios-retry';\naxiosRetry(${args});`, route("(await axios.get('http://up.test/a', { timeout: 2000 })).data"));
  expectFindings('axiosRetry(axios) with no options: no wait, error, an options argument added', { 'app.js': axr('axios') }, [['error', 'app.js', 4, 'auto']], RP);
  expectAutoFixHolds('  { retryDelay: axiosRetry.exponentialDelay } appended', { 'app.js': axr('axios') }, RP);
  expectFindings('axios-retry with linearDelay: error', { 'app.js': axr('axios, { retries: 2, retryDelay: axiosRetry.linearDelay() }') }, [['error', 'app.js', 4, 'auto']], RP);
  expectFindings('axios-retry retrying everything (retryCondition: () => true): RTY-06 warning', { 'app.js': axr('axios, { retryDelay: axiosRetry.exponentialDelay, retryCondition: () => true }') }, [['warning', 'app.js', 4, 'guided']], RP);
  const pr = (opts, inner = "const r = await fetch('http://up.test/a', { signal: AbortSignal.timeout(2000) });\n    if (r.status === 404) throw new AbortError('gone');\n    return r.json();") => fastify("import pRetry, { AbortError } from 'p-retry';", `app.get('/x', async function x() {\n  return pRetry(async () => {\n    ${inner}\n  }${opts});\n});`);
  expectFindings('p-retry with every default: 10 retries, no jitter, waits to 512 s: error', { 'app.js': pr('') }, [['error', 'app.js', 5, 'auto']], RP);
  expectAutoFixHolds('  { randomize: true, maxTimeout: 10_000 } appended', { 'app.js': pr('') }, RP);
  expectFindings('p-retry with retries: Infinity: RTY-01 error', { 'app.js': pr(', { retries: Infinity, randomize: true, maxTimeout: 5000 }') }, [['error', 'app.js', 5, 'auto']], RP);
  expectFindings('p-retry with retries: Infinity and a maxRetryTime is capped', { 'app.js': pr(', { retries: Infinity, maxRetryTime: 10_000, randomize: true, maxTimeout: 5000 }') }, [], RP);
  expectFindings('p-retry around axios with no AbortError: 4xx retried, warning', { 'app.js': pr(', { retries: 2, randomize: true }', "return (await axios.get('http://up.test/a', { timeout: 2000 })).data;").replace("import Fastify from 'fastify';", "import Fastify from 'fastify';\nimport axios from 'axios';") }, [['warning', 'app.js', 6, 'guided']], RP);
  const gt = (retry) => fastify("import got from 'got';", route(`got('http://up.test/a', { timeout: { request: 2000 }, retry: ${retry} }).json()`));
  expectFindings('got with noise: 0: no jitter, error', { 'app.js': gt('{ limit: 2, noise: 0 }') }, [['error', 'app.js', 5, 'auto']], RP);
  expectFindings('got with limit 8 and no backoffLimit: the last wait is 128 s, error', { 'app.js': gt('{ limit: 8 }') }, [['error', 'app.js', 5, 'auto']], RP);
  expectAutoFixHolds('  backoffLimit: 10_000 inserted', { 'app.js': gt('{ limit: 8 }') }, RP);
  expectFindings('got retrying 404: warning', { 'app.js': gt('{ limit: 2, statusCodes: [404, 500, 503] }') }, [['warning', 'app.js', 5, 'guided']], RP);
  const lp = (head, body) => fastify(`import axios from 'axios';\n${head}`, `app.get('/x', async function x() {\n${body}\n});`);
  const tryLoop = (header, wait, extra = '') => `  ${extra}${header} {\n    try {\n      return (await axios.get('http://up.test/a', { timeout: 2000 })).data;\n    } catch (err) {\n      if (attempt >= 3 || err.response?.status < 500) throw err;\n      ${wait}\n    }\n  }`;
  expectFindings('A doubling delay variable with no jitter: error, wrapped in Math.random()', { 'app.js': lp('', tryLoop('for (let attempt = 0; attempt < 4; attempt++)', 'await new Promise((r) => setTimeout(r, delay)); delay *= 2;', 'let delay = 100;\n  ')) }, [['error', 'app.js', 7, 'auto']], RP);
  expectAutoFixHolds('  Math.random() * Math.min(10_000, delay) holds', { 'app.js': lp('', tryLoop('for (let attempt = 0; attempt < 4; attempt++)', 'await new Promise((r) => setTimeout(r, delay)); delay *= 2;', 'let delay = 100;\n  ')) }, RP);
  expectFindings('A jittered wait that does not grow: warning', { 'app.js': lp("import { setTimeout as sleep } from 'node:timers/promises';", tryLoop('for (let attempt = 0; attempt < 4; attempt++)', 'await sleep(Math.random() * 1000);')) }, [['warning', 'app.js', 6, 'auto']], RP);
  expectFindings('A do-while with a counter capped in its condition and jittered backoff: nothing', { 'app.js': lp("import { setTimeout as sleep } from 'node:timers/promises';", "  let attempt = 0;\n  do {\n    try {\n      return (await axios.get('http://up.test/a', { timeout: 2000 })).data;\n    } catch (err) {\n      if (err.response?.status < 500) throw err;\n      await sleep(Math.random() * Math.min(10_000, 100 * 2 ** attempt));\n    }\n    attempt++;\n  } while (attempt < 3);\n  throw new Error('down');") }, [], RP);
  expectFindings('A retry loop around a project function that calls fetch is a retry', { 'app.js': lp("import { setTimeout as sleep } from 'node:timers/promises';\nasync function up() { const r = await fetch('http://up.test/a', { signal: AbortSignal.timeout(2000) }); if (r.status >= 400 && r.status < 500) throw Object.assign(new Error('4xx'), { status: r.status }); if (!r.ok) throw new Error('5xx'); return r.json(); }", "  for (let attempt = 0; attempt < 3; attempt++) {\n    try {\n      return await up();\n    } catch (err) {\n      if (err.status) throw err;\n      await sleep(250);\n    }\n  }") }, [['error', 'app.js', 7, 'auto']], RP);
  expectFindings('A retry loop around a database query is not judged (outbound HTTP only)', { 'app.js': fastify("import pg from 'pg';\nconst pool = new pg.Pool();", "app.get('/x', async function x() {\n  for (let attempt = 0; attempt < 3; attempt++) {\n    try {\n      return (await pool.query('select 1')).rows;\n    } catch {}\n  }\n});") }, [], RP);
  expectFindings('No handler found: info', { 'job.js': "import axios from 'axios';\nexport async function job() {\n  while (true) {\n    try {\n      return (await axios.get('http://up.test/a', { timeout: 2000 })).data;\n    } catch (err) {\n      if (err.response?.status < 500) throw err;\n    }\n  }\n}\n" }, [['info', 'job.js', 3, 'guided'], ['info', 'job.js', 3, 'guided']], RP);
}

console.log('\nmissing-index: schemas, predicates and fixes');
{
  const MI = ['missing-index'];
  const fastify = (q) => `import Fastify from 'fastify';\nimport pg from 'pg';\nconst pool = new pg.Pool();\nconst app = Fastify();\napp.get('/x', async function x(request) {\n  return (await pool.query(${q})).rows;\n});\napp.listen({ port: 3000 });\n`;
  const ddl = (extra = '') => `create table events (\n  id bigserial primary key,\n  user_id bigint not null,\n  kind text not null,\n  email text,\n  created_at timestamptz not null\n);\n${extra}`;
  const sqlCase = (name, q, extra, want) => expectFindings(name, { 'app.js': fastify(q), 'db/001_init.sql': ddl(extra) }, want, MI);
  sqlCase('A composite index whose first column is filtered serves it', "'select id from events where user_id = $1', [request.params.id]", 'create index events_user_kind on events (user_id, kind);\n', []);
  sqlCase('An index whose second column is filtered does not', "'select id from events where kind = $1', [request.query.k]", 'create index events_user_kind on events (user_id, kind);\n', [['warning', 'app.js', 6, 'auto']]);
  sqlCase('A unique constraint added by ALTER TABLE is an index', "'select id from events where email = $1', [request.query.e]", 'alter table events add constraint events_email_key unique (email);\n', []);
  sqlCase('An index on lower(email) does not serve email = $1', "'select id from events where email = $1', [request.query.e]", 'create index events_email_lower on events (lower(email));\n', [['warning', 'app.js', 6, 'auto']]);
  sqlCase('A filter with OR is not judged', "'select id from events where user_id = $1 or kind = $2', [1, 'a']", '', []);
  sqlCase('A subquery is not judged (counted as unreadable)', "'select id from events where user_id in (select id from users where active)'", '', []);
  sqlCase('ORDER BY with LIMIT and no filter sorts the whole table: reported', "'select id from events order by created_at desc limit 20'", '', [['warning', 'app.js', 6, 'auto']]);
  sqlCase('ORDER BY with no LIMIT is not judged', "'select id, kind from events order by created_at'", '', []);
  sqlCase('$queryRaw-style template text with an interpolation is read', '`select id from events where kind = ${request.query.k}`', '', [['warning', 'app.js', 6, 'auto']]);
  expectAutoFixHolds('  the auto fix writes db/002_events_kind_idx.sql', { 'app.js': fastify("'select id from events where kind = $1', [request.query.k]"), 'db/001_init.sql': ddl() }, MI);
  expectFindings('Migrations that are not numbered files: the fix is guided', { 'app.js': fastify("'select id from events where kind = $1', [request.query.k]"), 'schema.sql': ddl() }, [['warning', 'app.js', 6, 'guided']], MI);
  expectFindings('A table with no DDL in the repository is not judged', { 'app.js': fastify("'select id from sessions where token = $1', [1]"), 'db/001_init.sql': ddl() }, [], MI);
  expectFindings('No handler: a query finding is info, a foreign key stays a warning', { 'job.js': "import pg from 'pg';\nconst pool = new pg.Pool();\nexport const run = () => pool.query('select id from events where kind = $1', ['a']);\n", 'db/001_init.sql': ddl('create table notes (\n  id bigserial primary key,\n  event_id bigint references events (id)\n);\n') }, [['info', 'job.js', 3, 'auto'], ['warning', 'db/001_init.sql', 10, 'auto']], MI);
  const prisma = (provider, extra = '', model = '') => `datasource db {\n  provider = "${provider}"\n${extra}}\n\nmodel User {\n  id    Int    @id\n  posts Post[]\n}\n\nmodel Post {\n  id     Int    @id\n  userId Int\n  user   User   @relation(fields: [userId], references: [id])\n  title  String\n${model}}\n`;
  const express = (call) => `import express from 'express';\nimport { PrismaClient } from '@prisma/client';\nconst prisma = new PrismaClient();\nconst app = express();\napp.get('/x', async (req, res) => {\n  res.json(await ${call});\n});\napp.listen(3000);\n`;
  expectFindings('Prisma on MySQL: relation foreign keys are indexed by the database', { 'prisma/schema.prisma': prisma('mysql'), 'app.js': express("prisma.user.findMany({ take: 5 })") }, [], MI);
  expectFindings('Prisma relationMode = "prisma": no foreign keys in the database', { 'prisma/schema.prisma': prisma('postgresql', '  relationMode = "prisma"\n'), 'app.js': express("prisma.user.findMany({ take: 5 })") }, [], MI);
  expectFindings('Prisma @@index(fields: [userId]) in its named form', { 'prisma/schema.prisma': prisma('postgresql', '', '  @@index(fields: [userId], name: "post_user")\n'), 'app.js': express("prisma.post.findMany({ where: { userId: 1 } })") }, [], MI);
  expectFindings('Prisma AND: [...] is read; contains is not indexable', { 'prisma/schema.prisma': prisma('postgresql', '', '  @@index([userId])\n'), 'app.js': express("prisma.post.findMany({ where: { AND: [{ title: { equals: 'a' } }, { userId: { contains: 'x' } }] } })") }, [['warning', 'app.js', 6, 'auto']], MI);
}

console.log('\nTrace judgements (lib/trace-judge.js)');
{
  // Two measured runs of one request match on everything but the fields a
  // run lists as measured (lib/trace-judge.js runShape, through the
  // finding/1 mechanism); a count that differs is never ignored.
  const run = (o = {}) => ({ status: 200, timedOut: false, bytes: 2048, ms: 4.1, load1: 3.2, loop: { maxMs: 1.2 }, statements: { 'select * from orders where id = $1': { calls: 3, rows: 3 } }, items: 3, ...o, measured: TJ.RUN_MEASURED });
  const same = (a, b) => TJ.runShape(a) === TJ.runShape(b);
  ok('runs that differ only in measured values (time, bytes, load average, the loop) match', same(run(), run({ ms: 9.7, bytes: 2051, load1: 5.6, loop: { maxMs: 3.4 } })));
  ok('runs whose statement count differs do not match', !same(run(), run({ statements: { 'select * from orders where id = $1': { calls: 4, rows: 4 } } })));
  ok('runs whose item count differs do not match, whatever their measured values', !same(run(), run({ items: 4, ms: 4.1, load1: 3.2 })));
  ok('a field a run does not list as measured is compared', !same(run({ measured: undefined }), { ...run({ load1: 9.9 }), measured: undefined }) && !same({ ...run(), measured: [] }, { ...run({ load1: 9.9 }), measured: [] }));
}
{
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok('expand: $n and $i as whole values become numbers, inside strings they are substituted', eq(TJ.expand({ ids: { $repeat: '$n', item: '$i' }, rows: { $repeat: 2, item: { sku: 'sku-$i', n: '$n' } }, path: '/x?limit=$n' }, 3), { ids: [1, 2, 3], rows: [{ sku: 'sku-1', n: 3 }, { sku: 'sku-2', n: 3 }], path: '/x?limit=3' }));
  {
    const s = { check: 'n-plus-one', rules: ['DAT-07'], where: { endpoints: [{ method: 'GET', route: '/orders' }], locations: [{ file: 'a.js', line: 3 }] }, erlang: { client: 'prisma' } };
    const t = { check: 'n-plus-one', rule: 'DAT-07', method: 'GET', route: '/orders', statement: 'SELECT "public"."Customer"."id" FROM "public"."Customer" WHERE "id" = $1' };
    const line = () => 'for (const o of orders) o.customer = await prisma.customer.findUnique({ where: { id: o.customerId } });';
    ok('linkStatic: a Prisma finding links by check, rule and endpoint, with no SQL in its source', TJ.linkStatic(t, [s], line) === s);
    ok('  the control: the same finding from pg needs the statement on its line', TJ.linkStatic(t, [{ ...s, erlang: { client: 'pg' } }], line) === null);
    ok('  and a Prisma finding at another endpoint does not link', TJ.linkStatic({ ...t, route: '/invoices' }, [s], line) === null);
  }
  ok('expand: $list in a string becomes 1,2,...,n', TJ.expand('/p?ids=$list&n=$n', 3) === '/p?ids=1,2,3&n=3');
  const routes = [{ method: 'GET', url: '/products/:id' }, { method: 'GET', url: '/products/prices' }, { method: 'GET', url: '/products/:id/price' }, { method: 'POST', url: '/products/:id' }];
  ok('routeOf: a static segment wins over a parameter, the method matters, the query is ignored', TJ.routeOf(routes, 'GET', '/products/prices?ids=1,2') === '/products/prices' && TJ.routeOf(routes, 'GET', '/products/7') === '/products/:id' && TJ.routeOf(routes, 'GET', '/products/7/price') === '/products/:id/price' && TJ.routeOf(routes, 'DELETE', '/products/7') === null);
  ok('growth: one statement per item grows (11 for 10, 51 for 50)', TJ.growth({ n1: 10, n10: 50, c1: 11, c10: 51 }).verdict === 'grows');
  ok('growth: the same count at both scales is fixed', TJ.growth({ n1: 10, n10: 100, c1: 1, c10: 1 }).verdict === 'fixed');
  ok('growth: a request with no items is judged on the ratio alone', TJ.growth({ n1: null, n10: null, c1: 3, c10: 3 }).verdict === 'fixed' && TJ.growth({ n1: null, n10: null, c1: 2, c10: 4 }).verdict === 'uncertain');
  ok('growth: pages of 500 (2 statements, then 3, for 100 then 1,000 rows) are neither: uncertain', TJ.growth({ n1: 100, n10: 1000, c1: 2, c10: 3 }).verdict === 'uncertain');
  ok('growth: the thresholds are the decided starting values', TJ.SLOPE === 0.5 && TJ.FIXED === 1.2 && TJ.ROWS === 5);
  ok('rowsGrowth: 10x the rows grows; 200 and 200 is bounded; 0 then some is infinite growth', TJ.rowsGrowth({ r1: 1000, r10: 10000 }).verdict === 'grows' && TJ.rowsGrowth({ r1: 200, r10: 200 }).verdict === 'bounded' && TJ.rowsGrowth({ r1: 0, r10: 5 }).ratio === Infinity);
  ok('repeated: the statement whose calls grow most; ties go to the first by text', eq(TJ.repeated({ 'select b': { c1: 1, c10: 1 }, 'select a': { c1: 10, c10: 100 }, 'select c': { c1: 10, c10: 100 } }), { query: 'select a', c1: 10, c10: 100 }));
  const read = new Set();
  const data = [{ id: 1, name: 'a', description: 'x'.repeat(100), meta: { tags: ['t'], size: 3 } }, { id: 2, name: 'b', description: 'y', meta: { tags: [], size: 4 } }];
  const view = TJ.track(data, read);
  const shown = view.map((p) => ({ name: p.name, size: p.meta.size }));
  ok('track: records the paths a page reads, through map() and nested objects', eq([...read].sort(), ['[].meta', '[].meta.size', '[].name']) && shown[1].size === 4, JSON.stringify([...read]));
  const unread = TJ.unreadBytes(data, read);
  const expected = ['"id":1', `"description":"${'x'.repeat(100)}"`, '"tags":["t"]', '"id":2', '"description":"y"', '"tags":[]'].reduce((s, t) => s + t.length, 0);
  ok('unreadBytes: each unread property, key and value, counted once', unread === expected, `${unread} against ${expected}`);
  ok('unreadFields: the unread property names of the items', eq(TJ.unreadFields(data, read), ['description', 'id']));
  ok('routePattern: matches the handler and a templated caller, not a longer route', TJ.routePattern('/products/:id/price').test("app.get('/products/:id/price', h)") && TJ.routePattern('/products/:id/price').test('api.get(`/products/${p.id}/price`)') && !TJ.routePattern('/products').test("app.get('/products/:id', h)") && TJ.routePattern('/products').test("api.get('/products')"));
  const statics = [{ check: 'n-plus-one', where: { endpoints: [{ method: 'GET', route: '/orders' }], locations: [{ file: 'a.js', line: 2 }] } }];
  const lines = { 'a.js': ['', "  q('select id, name from customers where id = $1', [x])"] };
  const lineOf = (f, l) => lines[f]?.[l - 1] ?? null;
  ok('linkStatic: the same check, route and statement links', TJ.linkStatic({ check: 'n-plus-one', method: 'GET', route: '/orders', statement: 'SELECT id, name FROM customers WHERE id = $1' }, statics, lineOf) === statics[0]);
  ok('linkStatic: another statement, route or check does not', !TJ.linkStatic({ check: 'n-plus-one', method: 'GET', route: '/orders', statement: 'select id from products where id = $1' }, statics, lineOf) && !TJ.linkStatic({ check: 'n-plus-one', method: 'GET', route: '/stats', statement: 'select id, name from customers where id = $1' }, statics, lineOf) && !TJ.linkStatic({ check: 'per-row-writes', method: 'GET', route: '/orders', statement: 'select id, name from customers where id = $1' }, statics, lineOf));
  const lib = [{ check: 'no-timeout', rules: ['TMO-01'], where: { locations: [{ file: 'q.js', line: 5, symbol: 'getQuote' }] } }];
  ok('linkStatic: a static finding with no endpoint links by the symbol the trace names, and the rule', TJ.linkStatic({ check: 'no-timeout', rule: 'TMO-01', method: 'GET', route: '/call/getQuote', symbol: 'getQuote' }, lib, lineOf) === lib[0]);
  ok('linkStatic: no endpoint and no symbol, or another symbol or rule, does not link', !TJ.linkStatic({ check: 'no-timeout', rule: 'TMO-01', method: 'GET', route: '/call/getQuote' }, lib, lineOf) && !TJ.linkStatic({ check: 'no-timeout', rule: 'TMO-01', method: 'GET', route: '/x', symbol: 'charge' }, lib, lineOf) && !TJ.linkStatic({ check: 'no-timeout', rule: 'TMO-02', method: 'GET', route: '/x', symbol: 'getQuote' }, lib, lineOf));
}

console.log('\npool-exhaustion: checkouts, releases and calls held across');
{
  const PE = ['pool-exhaustion'];
  const app = (body, head = "import pg from 'pg';\nconst pool = new pg.Pool({ max: 4 });") => `import express from 'express';\n${head}\nconst app = express();\napp.get('/x', async (req, res) => {\n${body}\n});\napp.listen(3000);\n`;
  const peCase = (name, body, want, extra = {}, head) => expectFindings(name, { 'app.js': app(body, head), ...extra }, want, PE);
  const q = "  await client.query('select 1');";
  peCase('Released in finally: nothing', `  const client = await pool.connect();\n  try {\n  ${q}\n  } finally {\n    client.release();\n  }`, []);
  peCase('Released after the queries, with no try: an error, fixed automatically', `  const client = await pool.connect();\n${q}\n  client.release();\n  res.json({});`, [['error', 'app.js', 6, 'auto']]);
  peCase('Never released: an error, fixed automatically', `  const client = await pool.connect();\n${q}\n  res.json({});`, [['error', 'app.js', 6, 'auto']]);
  peCase('Released in the catch and the try, but a return comes first in the try: an error', `  const client = await pool.connect();\n  try {\n  ${q}\n    if (req.query.x) return res.json({});\n    client.release();\n  } catch (e) {\n    client.release();\n    throw e;\n  }`, [['error', 'app.js', 6, 'guided']]);
  peCase('A finally that starts after a query: the query can throw first, so an error', `  const client = await pool.connect();\n${q}\n  try {\n  ${q}\n  } finally {\n    client.release();\n  }`, [['error', 'app.js', 6, 'guided']]);
  peCase('Released through .finally() on the promise: nothing', "  const client = await pool.connect();\n  res.json(await client.query('select 1').finally(() => client.release()));", []);
  peCase('The callback form is not judged', "  pool.connect((err, client, done) => { res.json({}); });", []);
  peCase('A pg Client, not a pool: nothing', `  const client = new pg.Client();\n  await client.connect();\n${q}`, []);
  peCase("pg's named Pool export is a pool", `  const client = await pool.connect();\n${q}`, [['error', 'app.js', 6, 'auto']], {}, "import { Pool } from 'pg';\nconst pool = new Pool();");
  peCase('pg-pool is a pool', `  const client = await pool.connect();\n${q}`, [['error', 'app.js', 6, 'auto']], {}, "import Pool from 'pg-pool';\nconst pool = new Pool();");
  peCase('A client returned to the caller is the caller\'s to release: not judged', "  const client = await pool.connect();\n  return client;", []);
  const held = (call) => `  const client = await pool.connect();\n  try {\n    const r = await ${call};\n  ${q}\n  } finally {\n    client.release();\n  }`;
  peCase('Held across a got call: a warning, guided', held("got.post('http://svc/a').json()"), [['warning', 'app.js', 9, 'guided']], {}, "import pg from 'pg';\nimport got from 'got';\nconst pool = new pg.Pool();");
  peCase('Held across a helper that calls a helper that uses node:http: a warning', held('notify(req.query.id)'), [['warning', 'app.js', 9, 'guided']],
    { 'notify.js': "import { send } from './send.js';\nexport async function notify(id) { return send(id); }\n", 'send.js': "import https from 'node:https';\nexport const send = (id) => new Promise((ok) => https.request(`https://svc/${id}`, { timeout: 5000 }, ok).end());\n" },
    "import pg from 'pg';\nimport { notify } from './notify.js';\nconst pool = new pg.Pool();");
  peCase('Held across a helper with no I/O: nothing', held('check(req.query)'), [], { 'check.js': 'export async function check(q) { return q.id > 0; }\n' }, "import pg from 'pg';\nimport { check } from './check.js';\nconst pool = new pg.Pool();");
  peCase('A fetch before the checkout: nothing', `  const r = await fetch('http://svc/a', { signal: AbortSignal.timeout(5000) });\n${held('Promise.resolve(r)')}`, []);
  {
    const r = scanOf(subject({ 'app.js': app(`  const client = await pool.connect();\n${q}`, "import pg from 'pg';\nconst pool = new pg.Pool();") }), PE);
    ok('With no max, the message names pg\'s default of 10, and an anonymous handler by its route', r.findings[0]?.message.startsWith('The GET /x handler checks') && r.findings[0]?.message.includes("its 10 connections (pg's default)"), r.findings[0]?.message);
  }
  expectFindings('No handler: a leak is info, unresolved', { 'job.js': "import pg from 'pg';\nconst pool = new pg.Pool();\nexport async function run() {\n  const c = await pool.connect();\n  await c.query('select 1');\n}\n" }, [['info', 'job.js', 4, 'auto']], PE);
  expectAutoFixHolds('  the auto fix wraps the rest in try and releases in finally (release moved)', { 'app.js': app(`  const client = await pool.connect();\n${q}\n  client.release();\n  res.json({});`) }, PE);
  expectAutoFixHolds('  the auto fix adds the missing release', { 'app.js': app(`  const client = await pool.connect();\n${q}\n  res.json({});`) }, PE);
}

console.log('\nblocking-work: synchronous calls on the request thread');
{
  const BW = ['blocking-work'];
  const app = (head, body, extra = {}) => ({ 'app.js': `import express from 'express';\n${head}\nconst app = express();\napp.post('/x', async (req, res) => {\n${body}\n  res.end();\n});\napp.listen(3000);\n`, ...extra });
  const bw = (name, head, body, want, extra) => expectFindings(name, app(head, body, extra), want, BW);
  bw('crypto.pbkdf2Sync through the default import: auto', "import crypto from 'node:crypto';", "  const k = crypto.pbkdf2Sync(req.body.p, 's', 1000, 32, 'sha256');", [['warning', 'app.js', 5, 'auto']]);
  {
    const r = bw('A named import: guided, naming the import line too', "import { scryptSync } from 'crypto';", "  const k = scryptSync(req.body.p, 's', 32);", [['warning', 'app.js', 5, 'guided']]);
    ok('  its locations are the call, then the import', JSON.stringify(r.findings[0]?.erlang.fix.locations.map((l) => l.line)) === '[5,2]', JSON.stringify(r.findings[0]?.erlang.fix.locations));
  }
  bw('fs.existsSync has no promise form: guided', "import fs from 'node:fs';", "  if (fs.existsSync('x')) res.status(409);", [['warning', 'app.js', 5, 'guided']]);
  bw('child_process.execSync: guided', "import cp from 'node:child_process';", "  cp.execSync('ls');", [['warning', 'app.js', 5, 'guided']]);
  bw('Inside a callback that is not async: guided', "import zlib from 'node:zlib';", "  const out = req.body.parts.map((p) => zlib.gzipSync(p));", [['warning', 'app.js', 5, 'guided']]);
  bw('In a helper that is not async, reached by the handler: guided, at the helper', "import { load } from './load.js';", '  load();', [['warning', 'load.js', 2, 'guided']], { 'load.js': "import fs from 'node:fs';\nexport function load() { return fs.readFileSync('x'); }\n" });
  bw('randomBytes(16) is quick, and with a callback runs on the worker pool: nothing', "import crypto from 'node:crypto';", '  const a = crypto.randomBytes(16);\n  crypto.randomBytes(1 << 20, () => {});', []);
  bw('randomBytes of a size from the request: auto', "import crypto from 'node:crypto';", '  const a = crypto.randomBytes(req.body.n);', [['warning', 'app.js', 5, 'auto']]);
  bw('fs/promises, crypto.createHash and zlib.gzip: nothing', "import fs from 'node:fs';\nimport crypto from 'node:crypto';\nimport zlib from 'node:zlib';", "  const t = await fs.promises.readFile('x');\n  crypto.createHash('sha1').update(t).digest();\n  zlib.gzip(t, () => {});", []);
  expectFindings('CommonJS require of crypto: auto', { 'app.js': "const express = require('express');\nconst crypto = require('crypto');\nconst app = express();\napp.post('/x', async (req, res) => {\n  res.send(crypto.pbkdf2Sync(req.body.p, 's', 1000, 32, 'sha256'));\n});\napp.listen(3000);\n" }, [['warning', 'app.js', 5, 'auto']], BW);
  {
    const r = scanOf(subject({ 'tool.js': "import fs from 'node:fs';\nimport bcrypt from 'bcryptjs';\nconsole.log(bcrypt.hashSync(fs.readFileSync(process.argv[2], 'utf8'), 10));\n" }), BW);
    ok('No handler: nothing reported, and the run data says why', r.status === 'complete' && r.findings.length === 0 && r.erlang.checks['blocking-work'].notes.some((x) => x.includes('not judged')) && r.erlang.checks['blocking-work'].skipped.noHandlers === 2, summary(r));
  }
  {
    const r = scanOf(subject(app("import zlib from 'node:zlib';", '  zlib.gunzipSync(req.body.blob);')), BW);
    ok('A synchronous gunzip is named as decompression, whose size the sender chooses', r.findings[0]?.message.includes("decompresses the whole input on the request thread, and its size is the sender's to choose"), r.findings[0]?.message);
  }
  expectAutoFixHolds('  the auto fix for generateKeyPairSync resolves { publicKey, privateKey }', app("import crypto from 'node:crypto';", "  const { publicKey } = crypto.generateKeyPairSync('ed25519');"), BW);
  expectAutoFixHolds('  the auto fix for fs.readFileSync uses fs.promises', app("import * as fs from 'node:fs';", "  const t = fs.readFileSync('x', 'utf8');"), BW);
  expectAutoFixHolds("  the auto fix for bcrypt's compareSync awaits compare", app("import bcrypt from 'bcrypt';", '  const ok = bcrypt.compareSync(req.body.p, req.body.h);'), BW);
  const BJ = "import bcrypt from 'bcryptjs';";
  bw('bcryptjs: the asynchronous hash at cost 12 is a warning, guided (Q4)', BJ, '  const h = await bcrypt.hash(req.body.p, 12);', [['warning', 'app.js', 5, 'guided']]);
  bw('  the control: the native bcrypt package\'s asynchronous hash is not reported', "import bcrypt from 'bcrypt';", '  const h = await bcrypt.hash(req.body.p, 12);', []);
  bw('bcryptjs at cost 9, through a const: nothing', `${BJ}\nconst COST = 9;`, '  const h = await bcrypt.hash(req.body.p, COST);', []);
  bw('bcryptjs with genSalt() and no cost: 10, the default, a warning', BJ, '  const h = await bcrypt.hash(req.body.p, await bcrypt.genSalt());', [['warning', 'app.js', 5, 'guided']]);
  bw('bcryptjs with a literal salt at $2b$08$: nothing', BJ, "  const h = bcrypt.hashSync(req.body.p, '$2b$08$abcdefghijklmnopqrstuu');", []);
  bw('bcryptjs at a cost from the request: info, the cost unknown', BJ, '  const h = await bcrypt.hash(req.body.p, req.body.cost);', [['info', 'app.js', 5, 'guided']]);
  bw('bcryptjs compare: the cost of the hashes stored under the same name', BJ, '  const ok = await bcrypt.compare(req.body.p, req.user.pin);\n  const ok2 = await bcrypt.compare(req.body.p, req.user.password);\n  req.user.pin = await bcrypt.hash(req.body.pin, 4);\n  const password = await bcrypt.hash(req.body.p, 11);', [['warning', 'app.js', 6, 'guided'], ['warning', 'app.js', 8, 'guided']]);
  {
    const r = scanOf(subject(app(BJ, '  const h = await bcrypt.hash(req.body.p, 12);')), BW);
    const f = r.findings[0];
    ok('  the fix note gives a migration path, and the fingerprint holds no cost', /verify a login with the old hash, then re-hash/.test(f?.erlang.fix.note ?? '') && !/12/.test(f?.fingerprint ?? ''), f?.fingerprint);
  }
  expectAutoFixHolds('  the auto fix for zlib.brotliCompressSync awaits brotliCompress', app("import zlib from 'node:zlib';", '  const z = zlib.brotliCompressSync(req.body.b, {});'), BW);
}

console.log('\noversized-payload: SELECT *, compression and calls per item');
{
  const OP = ['oversized-payload'];
  const fastify = (q, extra = '') => `import Fastify from 'fastify';\nimport compress from '@fastify/compress';\nimport pg from 'pg';\nconst pool = new pg.Pool();\nexport const app = Fastify();\napp.register(compress);\napp.get('/x', async function x(request) {\n  return (await pool.query(${q})).rows;\n});\n${extra}`;
  expectFindings('SELECT * of a list: a warning, guided', { 'app.js': fastify("'select * from events order by id limit 50'") }, [['warning', 'app.js', 8, 'guided']], OP);
  expectFindings('SELECT e.* with a join: a warning', { 'app.js': fastify("'select e.*, u.name from events e join users u on u.id = e.user_id'") }, [['warning', 'app.js', 8, 'guided']], OP);
  expectFindings('SELECT * by primary key, LIMIT 1 and count(*): nothing', { 'app.js': fastify("'select * from events where id = $1', [1]") + "app.get('/y', async () => (await pool.query('select * from events order by id desc limit 1')).rows);\napp.get('/z', async () => (await pool.query('select count(*) from events')).rows);\n" }, [], OP);
  expectFindings('SELECT * by a column the migration makes unique: nothing', { 'app.js': fastify("'select * from users where email = $1', ['a']"), 'db/001.sql': 'create table users (id bigint primary key, email text unique);\n' }, [], OP);
  {
    const dir = subject({ 'app.js': fastify("'select * from countries'"), 'erlang.config.json': '{ "smallTables": ["countries"] }\n' });
    ok('SELECT * on a table under smallTables: nothing', scanOf(dir, OP).findings.length === 0);
  }
  const express = (head, mw = '') => `import express from 'express';\n${head}\nconst app = express();\n${mw}app.get('/x', (req, res) => res.json({ ok: true }));\napp.listen(3000);\n`;
  expectFindings('An Express app with no compression: a warning at express()', { 'app.js': express('') }, [['warning', 'app.js', 3, 'guided']], OP);
  expectFindings('An Express app with compression(): nothing', { 'app.js': express("import compression from 'compression';", 'app.use(compression());\n') }, [], OP);
  expectFindings('No compression in the app, but nginx compresses (gzip on): nothing', { 'app.js': express(''), 'deploy/nginx.conf': 'server {\n  gzip on;\n  location / { proxy_pass http://127.0.0.1:3000; }\n}\n' }, [], OP);
  expectFindings('A Caddyfile with encode: nothing', { 'app.js': express(''), 'Caddyfile': 'example.com {\n  encode gzip zstd\n  reverse_proxy 127.0.0.1:3000\n}\n' }, [], OP);
  expectFindings('nginx with gzip commented out still counts as uncompressed', { 'app.js': express(''), 'nginx.conf': 'server {\n  # gzip on;\n}\n' }, [['warning', 'app.js', 3, 'guided']], OP);
  const page = (body) => ({ 'web/page.js': `export async function list(api) {\n  const items = await api.get('/items');\n${body}\n}\n` });
  expectFindings('Promise.all over items.map with the item in the URL: a warning', page('  return Promise.all(items.map((i) => api.get(`/items/${i.id}/stock`)));'), [['warning', 'web/page.js', 3, 'guided']], OP);
  expectFindings('fetch in a for-of over a list: a warning', page('  for (const i of items) await fetch(`/items/${i.id}`);'), [['warning', 'web/page.js', 3, 'guided']], OP);
  expectFindings('A URL that does not use the item: nothing', page('  for (const i of items) await api.get(\'/ping\');'), [], OP);
  expectFindings('An absolute URL to another service: not this check', page('  for (const i of items) await fetch(`https://other.example/items/${i.id}`);'), [], OP);
  expectFindings('A literal list of three: nothing', page("  for (const k of ['a', 'b', 'c']) await api.get(`/items/count?kind=${k}`);"), [], OP);
  {
    const r = scanOf(subject({ 'job.js': "import pg from 'pg';\nconst pool = new pg.Pool();\nexport const all = () => pool.query('select * from events');\n" }), OP);
    ok('No handler: SELECT * is info, unresolved', r.findings.length === 1 && r.findings[0].severity === 'info' && r.findings[0].erlang.unresolved === true, summary(r));
  }
  {
    const r = scanOf(subject({ 'web/page.js': "export async function list(api) {\n  const rows = [];\n  for (const i of await api.get('/items')) rows.push(await api.get(`/items/${i.id}`));\n  return rows;\n}\n" }), OP);
    ok('The guided fix names the loop, the list it fills and where that list is used', JSON.stringify(r.findings[0]?.erlang.fix.locations.map((l) => l.line)) === '[2,3,4]', JSON.stringify(r.findings[0]?.erlang.fix.locations));
  }
}

console.log('\nmemory-growth: module-level collections that only grow');
{
  const MG = ['memory-growth'];
  const app = (decl, body, extra = {}) => ({ 'app.js': `import express from 'express';\nconst app = express();\n${decl}\napp.post('/x', (req, res) => {\n${body}\n  res.end();\n});\napp.listen(3000);\n`, ...extra });
  const mg = (name, decl, body, want, extra) => expectFindings(name, app(decl, body, extra), want, MG);
  mg('A Set added to per request: a warning, auto', 'const seen = new Set();', '  seen.add(req.body.id);', [['warning', 'app.js', 5, 'auto']]);
  mg('An array unshifted per request: a warning, auto', 'const log = [];', '  log.unshift(req.body);', [['warning', 'app.js', 5, 'auto']]);
  mg('An object with a computed key per request: a warning, guided', 'const byId = {};', '  byId[req.body.id] = req.body;', [['warning', 'app.js', 5, 'guided']]);
  mg('An object whose keys are deleted somewhere: nothing', 'const byId = {};\nexport const forget = (id) => { delete byId[id]; };', '  byId[req.body.id] = req.body;', []);
  mg('An array emptied by length = 0 somewhere: nothing', 'const log = [];\nexport const reset = () => { log.length = 0; };', '  log.push(req.body);', []);
  mg('A variable assigned again: nothing', 'let log = [];\nsetInterval(() => { log = []; }, 60_000);', '  log.push(req.body);', []);
  mg('A literal key: nothing', 'const counts = new Map();', "  counts.set('hits', (counts.get('hits') ?? 0) + 1);", []);
  mg('A collection exported and grown in another file: a warning there', "import { seen } from './store.js';", '  seen.add(req.body.id);', [['warning', 'app.js', 5, 'auto']], { 'store.js': 'export const seen = new Set();\n' });
  expectAutoFixHolds('  the auto fix for a Set drops its oldest value', app('const seen = new Set();', '  seen.add(req.body.id);'), MG);
  expectAutoFixHolds('  the auto fix for unshift pops', app('const log = [];', '  log.unshift(req.body);'), MG);
  {
    const r = scanOf(subject({ 'job.js': 'const seen = new Set();\nexport function mark(id) { seen.add(id); }\n' }), MG);
    ok('No handler: nothing reported, and the run data says why', r.findings.length === 0 && r.erlang.checks['memory-growth'].skipped.noHandlers === 1 && r.erlang.checks['memory-growth'].notes.some((x) => x.includes('not judged')), summary(r));
  }
}

console.log('\nno-cache: reads whose answer is already known');
{
  const NC = ['no-cache'];
  const app = (body, extra = '') => ({ 'app.js': `import express from 'express';\nimport pg from 'pg';\nconst pool = new pg.Pool();\nconst app = express();\n${extra}app.get('/x', async (req, res) => {\n${body}\n  res.end();\n});\napp.listen(3000);\n` });
  const nc = (name, body, want, extra) => expectFindings(name, app(body, extra), want, NC);
  nc('A loop-invariant read in a map callback: a warning, guided', "  await Promise.all(req.body.ids.map(async (id) => (await pool.query('select rate from fx where pair = $1', [req.query.pair])).rows));", [['warning', 'app.js', 6, 'guided']]);
  nc('A read using a variable the loop assigns: nothing', "  let page = 0;\n  for (const id of req.body.ids) { page += 1; await pool.query('select * from t where p = $1 limit 1', [page]); }", []);
  nc('A read in a counter loop: not judged', "  for (let i = 0; i < 3; i++) await pool.query('select 1');", []);
  nc('The same read in two different blocks: nothing', "  if (req.query.a) await pool.query('select value from settings where name = $1', ['a']);\n  else await pool.query('select value from settings where name = $1', ['a']);", []);
  nc('A Prisma read inside a loop, the same each pass: a warning', "  for (const id of req.body.ids) await prisma.setting.findUnique({ where: { name: 'currency' } });", [['warning', 'app.js', 8, 'guided']], "import { PrismaClient } from '@prisma/client';\nconst prisma = new PrismaClient();\n");
  nc('An aggregate behind a module-level let: nothing', "  if (!memo) memo = (await pool.query('select count(*) from orders')).rows[0];\n  res.json(memo);", [], 'let memo = null;\n');
  nc('An aggregate on a GET with nothing in front: info, unresolved', "  res.json((await pool.query('select sum(total) from orders')).rows[0]);", [['info', 'app.js', 6, 'guided']]);
  {
    const r = scanOf(subject({ 'job.js': "import pg from 'pg';\nconst pool = new pg.Pool();\nexport async function f(ids) { for (const id of ids) await pool.query('select 1'); }\n" }), NC);
    ok('No handler: the loop-invariant read is info, unresolved', r.findings.length === 1 && r.findings[0].severity === 'info' && r.findings[0].erlang.unresolved === true, summary(r));
  }
}

console.log('\ncold-start: set-up done by the first request');
{
  const CS = ['cold-start'];
  const app = (decl, body, extra = '') => ({ 'app.js': `import express from 'express';\nimport { readFileSync } from 'node:fs';\nconst app = express();\n${decl}\n${extra}app.get('/x', async (req, res) => {\n${body}\n  res.end();\n});\napp.listen(3000);\n` });
  const cs = (name, decl, body, want, extra) => expectFindings(name, app(decl, body, extra), want, CS);
  cs('A block-form guard with a *Sync read: a warning', 'let words;', "  if (typeof words === 'undefined') { words = readFileSync('words.txt', 'utf8').split('\\n'); }", [['warning', 'app.js', 6, 'guided']]);
  cs('A promise memo of a slow project function: a warning, no race', 'let ready;\nasync function build() { await new Promise((r) => setTimeout(r, 10)); return 1; }', '  ready ??= build();\n  await ready;', [['warning', 'app.js', 7, 'guided']]);
  cs('A guard with an age: nothing', 'let memo = null;', "  if (!memo || Date.now() - memo.at > 1000) memo = { at: Date.now(), v: readFileSync('a.txt', 'utf8') };", []);
  cs('A cheap value: nothing', 'let re = null;', "  if (!re) re = new RegExp('^a+$');", []);
  {
    const r = scanOf(subject(app('let ready;\nasync function build() { await new Promise((r) => setTimeout(r, 10)); return 1; }', '  ready ??= build();\n  await ready;')), CS);
    ok('  the promise memo message does not claim a second build', r.findings.length === 1 && !r.findings[0].message.includes('starts the build again'), r.findings[0]?.message);
  }
  expectFindings('A Fastify plugin variable set by a handler: a warning', { 'app.js': "import Fastify from 'fastify';\nimport { readFileSync } from 'node:fs';\nconst app = Fastify();\napp.register(async function routes(f) {\n  let table = null;\n  f.get('/x', async () => {\n    if (!table) table = JSON.parse(readFileSync('t.json', 'utf8'));\n    return table;\n  });\n});\n" }, [['warning', 'app.js', 7, 'guided']], CS);
  {
    const r = scanOf(subject({ 'lib.js': "import { readFileSync } from 'node:fs';\nlet t;\nexport function get() { if (!t) t = readFileSync('t', 'utf8'); return t; }\n" }), CS);
    ok('No handler: nothing reported, and the run data says why', r.findings.length === 0 && r.erlang.checks['cold-start'].skipped.noHandlers === 1, summary(r));
  }
}

console.log('\nno-load-shedding: a cap on requests in flight');
{
  const LS = ['no-load-shedding'];
  const ex = (mid = '', after = '', extra = {}) => ({ 'app.js': `import express from 'express';\n${mid}const app = express();\n${after}app.get('/x', (req, res) => res.end());\nconst server = app.listen(3000);\n`, ...extra });
  expectFindings('An Express app with nothing in front: a warning, guided', ex(), [['warning', 'app.js', 2, 'guided']], LS);
  expectFindings('A maintenance middleware (503, no comparison) does not count', ex('', "app.use((req, res, next) => process.env.DOWN ? res.status(503).end() : next());\n"), [['warning', 'app.js', 2, 'guided']], LS);
  expectFindings('express-queue with a queuedLimit: nothing', ex("import queue from 'express-queue';\n", 'app.use(queue({ activeLimit: 10, queuedLimit: 5 }));\n'), [], LS);
  expectFindings('express-queue with no queuedLimit (unbounded): a warning', ex("import queue from 'express-queue';\n", 'app.use(queue({ activeLimit: 10 }));\n'), [['warning', 'app.js', 3, 'guided']], LS);
  expectFindings('maxConnections on the server app.listen() returned: nothing', { 'app.js': "import express from 'express';\nconst app = express();\napp.get('/x', (req, res) => res.end());\nconst server = app.listen(3000);\nserver.maxConnections = 200;\n" }, [], LS);
  expectFindings('nginx limit_conn: nothing', ex('', '', { 'deploy/nginx.conf': 'limit_conn_zone $binary_remote_addr zone=a:10m;\nserver {\n  limit_conn a 100;\n}\n' }), [], LS);
  expectFindings('HAProxy maxconn: nothing', ex('', '', { 'haproxy.cfg': 'backend app\n  server a 127.0.0.1:3000 maxconn 100\n' }), [], LS);
  expectFindings('A Fastify onRequest hook that refuses over a count: nothing', { 'app.js': "import Fastify from 'fastify';\nconst app = Fastify();\nlet n = 0;\napp.addHook('onRequest', async (req, reply) => { if (n > 100) return reply.code(503).send(); });\napp.get('/x', async () => 'ok');\n" }, [], LS);
  {
    const r = scanOf(subject({ 'srv.js': "import { createServer } from 'node:http';\nexport const s = createServer((req, res) => res.end());\n" }), LS);
    ok('No handler found: nothing reported, and the run data says why', r.findings.length === 0 && r.erlang.checks['no-load-shedding'].notes.some((x) => x.includes('not judged')), summary(r));
  }
}

console.log('\nretry-policy and retry-budget: layers and budgets');
{
  const RP = ['retry-policy'];
  const RB = ['retry-budget'];
  const loopAround = (call, cond = 'attempt >= 3') => `  for (let attempt = 1; ; attempt++) {\n    try {\n      return ${call};\n    } catch (err) {\n      if (${cond}) throw err;\n      await new Promise((r) => setTimeout(r, Math.random() * Math.min(10_000, 100 * 2 ** attempt)));\n    }\n  }`;
  const app = (head, body) => ({ 'app.js': `import express from 'express';\n${head}\nconst app = express();\napp.get('/x', async (req, res) => {\n${body}\n});\napp.listen(3000);\n` });
  expectFindings('A retry loop around a function that retries in a loop: RTY-02', app("import axios from 'axios';\nasync function once() {\n" + loopAround("(await axios.get('http://up.test/a', { timeout: 2000 })).data", 'attempt >= 3 || err.response?.status < 500') + '\n}', loopAround('await once()')), [['error', 'app.js', 15, 'guided']], RP);
  expectFindings('A retry loop around the default axios with axios-retry on it: RTY-02', app("import axios from 'axios';\nimport axiosRetry from 'axios-retry';\naxiosRetry(axios, { retryDelay: axiosRetry.exponentialDelay });", loopAround("(await axios.get('http://up.test/a', { timeout: 2000 })).data", 'attempt >= 3 || err.response?.status < 500')), [['error', 'app.js', 7, 'guided']], RP);
  expectFindings('A retry loop around got.post (got does not retry POST): nothing', app("import got from 'got';", loopAround("await got.post('http://up.test/a', { timeout: { request: 2000 } }).json()", 'attempt >= 3 || err.response?.statusCode < 500')), [], RP);
  expectFindings('A retry loop around got with retry.limit 0 on its instance: nothing', app("import got from 'got';\nconst up = got.extend({ retry: { limit: 0 }, timeout: { request: 2000 } });", loopAround("await up('http://up.test/a').json()", 'attempt >= 3 || err.response?.statusCode < 500')), [], RP);
  {
    const r = scanOf(subject(app("import got from 'got';", loopAround("await got('http://up.test/a', { timeout: { request: 2000 } }).json()", 'attempt >= 3 || err.response?.statusCode < 500'))), RP);
    const f = r.findings.find((x) => x.rules.includes('RTY-02'));
    ok('A loop of 3 around got\'s default GET retry: 9 attempts, said in the message', f?.erlang.attempts === 9 && f.message.includes('up to 9 calls'), f?.message);
  }
  expectFindings('A loop with no budget: retry-budget warning', app("import axios from 'axios';", loopAround("(await axios.get('http://up.test/a', { timeout: 2000 })).data", 'attempt >= 3 || err.response?.status < 500')), [['warning', 'app.js', 5, 'guided']], RB);
  expectFindings('A loop whose give-up test reads a module-level counter: a budget, nothing', app("import axios from 'axios';\nlet retriesThisMinute = 0;\nsetInterval(() => { retriesThisMinute = 0; }, 60_000).unref();", loopAround("(await axios.get('http://up.test/a', { timeout: 2000 })).data", 'attempt >= 3 || err.response?.status < 500 || ++retriesThisMinute > 60')), [], RB);
  expectFindings('axios-retry with retries: 0: not a retry, no budget needed', app("import axios from 'axios';\nimport axiosRetry from 'axios-retry';\naxiosRetry(axios, { retries: 0 });", "  res.json((await axios.get('http://up.test/a', { timeout: 2000 })).data);"), [], RB);
  {
    const r = scanOf(subject({ 'job.js': "import axios from 'axios';\nexport async function f() {\n" + loopAround("(await axios.get('http://up.test/a', { timeout: 2000 })).data", 'attempt >= 3 || err.response?.status < 500') + '\n}\n' }), RB);
    ok('No handler: the budget finding is info, unresolved', r.findings.length === 1 && r.findings[0].severity === 'info' && r.findings[0].erlang.unresolved === true, summary(r));
  }
}

console.log('\nShared rules: the timing lock and expected rows');
{
  const calm = { load1: 1, cpus: 8 };
  const busy = { load1: 4, cpus: 8 };
  const j = (samples, before = calm, after = calm) => TIMING.judge({ samples, before, after });
  ok('timing: three samples within 10% on a calm machine are reliable', j([100, 104, 108]).reliable);
  ok('timing: two samples are not', !j([100, 101]).reliable && j([100, 101]).reason === 'timing unreliable');
  ok('timing: a spread over 10% is not', !j([100, 105, 112]).reliable, JSON.stringify(j([100, 105, 112]).why));
  ok('timing: a spread of exactly 10% is', j([100, 105, 110.5]).reliable && j([100, 105, 110.5]).spread === 0.1);
  ok('timing: load at half the CPUs before is not', !j([100, 101, 102], busy).reliable);
  ok('timing: load at half the CPUs after is not', !j([100, 101, 102], calm, busy).reliable);
  ok('timing: an unknown environment is not', !j([100, 101, 102], null).reliable);
  ok('timing: unreliable makes a finding info, reliable keeps its severity', TIMING.severityUnder('error', j([1, 2])) === 'info' && TIMING.severityUnder('error', j([100, 101, 102])) === 'error');
  const f = (severity, file) => ({ check: 'x', severity, fingerprint: `${file}|${severity}`, message: '', where: { locations: [{ file, line: 1 }] } });
  const rep = (...findings) => ({ schema: 'report/1', status: 'complete', findings });
  const spec = { defects: [{ id: 'D', check: 'x', where: { file: 'a.js' } }], decoys: [], expected: [{ id: 'E', check: 'x', where: { file: 'b.js' } }] };
  const both = applyExpected(spec, { planted: rep(f('error', 'a.js'), f('info', 'b.js')), clean: rep(f('info', 'b.js')) });
  const scored = score(spec, both.reports);
  ok('expected: an info finding on both twins is set aside, neither catch nor false positive', !both.problems.length && scored.recall === 1 && scored.falsePositives.length === 0 && both.setAside.length === 2, JSON.stringify(both.problems));
  ok('  control: without expected rows the same reports give a false positive', score(spec, { planted: rep(f('error', 'a.js'), f('info', 'b.js')), clean: rep(f('info', 'b.js')) }).falsePositives.length === 2);
  ok('expected: missing from the clean twin is a problem', applyExpected(spec, { planted: rep(f('info', 'b.js')), clean: rep() }).problems.some((p) => p.includes('not reported on the clean twin')));
  ok('expected: reported as a warning is a problem', applyExpected(spec, { planted: rep(f('warning', 'b.js')), clean: rep(f('warning', 'b.js')) }).problems.some((p) => p.includes('must be info')));
}

console.log('\nIsolation and scope');
{
  const dir = subject({
    'good.js': 'export const f = (u) => fetch(u);\n',
    'bad.js': Buffer.from([0x66, 0x28, 0xc3, 0x28, 0x29, 0x0a]).toString('latin1'),
  });
  writeFileSync(join(dir, 'bad.js'), Buffer.from([0x66, 0x28, 0xc3, 0x28, 0x29, 0x0a]));
  const r = scanOf(dir);
  ok('A file that is not UTF-8 is unread, the report is partial, and other files are still checked', r.status === 'partial' && r.reason.includes('bad.js: not read') && r.findings.length === 1, `${r.status}; ${summary(r)}`);
}
{
  const dir = subject({ 'a.js': 'export const f = (u) => fetch(u);\n' });
  const quoted = 'SECRET_TEXT_FROM_A_FILE';
  const r = scan(dir, { modules: [{ CHECK: 'boom', run() { throw new SyntaxError(`Unexpected token ${quoted} at line 3 column 7`); } }] });
  ok('A check that throws stops itself only; the report is partial and describes the error without quoting it', r.status === 'partial' && r.reason.includes('boom: stopped') && r.reason.includes('line 3, column 7') && !r.reason.includes(quoted), r.reason);
}
ok('describe() gives a Plain error\'s own words, and only the kind and position of any other', describe(new Plain('too large')) === 'too large' && !describe(new Error('value=hunter2 at position 4')).includes('hunter2'));
{
  const dir = subject({ 'erlang.config.json': '{ "exclude": ["tools/"] }\n', 'tools/x.js': 'fetch(u);\n', 'src/y.js': 'export const g = (u) => fetch(u, { signal: AbortSignal.timeout(5) });\n' });
  const r = scanOf(dir);
  ok('erlang.config.json excludes a directory, and the report says so', r.status === 'complete' && r.findings.length === 0 && r.erlang.scope.exclude.includes('tools'), summary(r));
}
{
  const dir = subject({ 'erlang.config.json': '{ "exclude": ["nothing-here/"] }\n', 'a.js': '' });
  const r = scanOf(dir);
  ok('An exclude entry that matches nothing is a note in the report', r.erlang.scope.notes.some((x) => x.includes('nothing-here')));
}
{
  const dir = subject({ 'big.js': `export const s = '${'x'.repeat(1024 * 1024)}';\n` });
  const r = scanOf(dir);
  ok('A file over 1 MiB is not read as source: partial, with the reason in ERLANG\'s own words', r.status === 'partial' && /big\.js: not read, an error stopped it \(larger than \d+ bytes/.test(r.reason), r.reason);
}

console.log(failed ? `\n${failed} unit case(s) failed` : '\nevery unit case holds');
process.exit(failed ? 1 : 0);
