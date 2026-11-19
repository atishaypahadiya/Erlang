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
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scan } from '../bin/erlang.js';
import { apply, syntaxErrors, fileOf } from '../lib/fix.js';
import { describe, Plain } from '../lib/isolate.js';
import * as TJ from '../lib/trace-judge.js';
import * as TIMING from '../lib/timing.js';
import * as LOCK from '../lib/itten-lock.js';
import * as GUARD from '../lib/load-guard.js';
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
  ok('another format is not made active by the rule (docs/decisions.md, Q5)', seen['timing-5.json'] === 'other');
  ok('describe names the file, phase, project, pid and expiry', /timing-1\.json: ITTEN benchmark run of shop, pid 4242, until 2026-11-19T12:10:00Z/.test(LOCK.describe(LOCK.active({ env, now, isAlive })[0])));
  const t0 = Date.now();
  const held = await LOCK.waitForNoLock({ env, now, isAlive, limitMs: 1500 });
  ok('waitForNoLock rereads until its limit, then returns the active lock', !!held && Date.now() - t0 >= 1400, `${Date.now() - t0} ms`);
  ok('nothing in the lock directory is written or deleted', Object.entries(before).every(([f, t]) => existsSync(join(dir, f)) && readFileSync(join(dir, f), 'utf8') === t) && readdirSync(dir).length === Object.keys(files).length);
  for (const f of ['timing-1.json', 'timing-4.json']) rmSync(join(dir, f));
  ok('with only stale, other and non-lock files left, nothing is active', (await LOCK.waitForNoLock({ env, now, isAlive, limitMs: 0 })) === null);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\nThe load guard: loopback only, within caps');
{
  const refused = (f) => { try { f(); return false; } catch (e) { return e instanceof GUARD.Refused; } };
  ok('checkTarget: a twin on 127.0.0.1 with a port is loaded', GUARD.checkTarget('http://127.0.0.1:41234/orders/1').port === '41234');
  ok('checkTarget: ::1 and localhost are loopback too', !refused(() => GUARD.checkTarget('http://[::1]:8080/')) && !refused(() => GUARD.checkTarget('http://localhost:8080/')));
  ok('checkTarget: any other host is refused, with no override', ['http://10.0.0.5:80/', 'http://example.com:80/', 'http://127.0.0.2:80/', 'http://0.0.0.0:80/', 'http://169.254.169.254:80/'].every((u) => refused(() => GUARD.checkTarget(u))));
  ok('checkTarget: https, and a URL with no port, are refused', refused(() => GUARD.checkTarget('https://127.0.0.1:443/')) && refused(() => GUARD.checkTarget('http://127.0.0.1/')));
  ok('profile: CI=true is ci, anything else local', GUARD.profile({ CI: 'true' }) === 'ci' && GUARD.profile({}) === 'local');
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
  const good = run([0, 7, 15].map((k) => queued(k)));
  const f = good.planted?.findings[0];
  ok('shedding: the queueing twin is reported, the capped twin is not', good.code === 0 && /PASS  L12 express load planted: 1\/1/.test(good.text) && /PASS  L12 express load clean: 0/.test(good.text), good.text.trim());
  ok('  linked to the static finding by symbol, with load in its detection and its fingerprint unchanged', !!f && f.detection.includes('static') && f.detection.includes('load') && f.fingerprint === scan(join(form, 'planted')).findings.find((s) => s.check === 'no-load-shedding')?.fingerprint, f && JSON.stringify(f.detection));
  ok('  the measured shares are in erlang.load, never in the fingerprint', !!f && f.erlang.load.samples.length === 3 && f.erlang.load.timing.reliable === true && !/\d\.\d/.test(f.fingerprint), f?.fingerprint);
  const same = run([0, 7, 15].map((k) => { const q = queued(k); return { planted: q.clean, clean: q.clean }; }));
  ok('  the control: twins that behave alike give no finding, and the planted defect is missed', same.code === 1 && /missed no-load-shedding step past/.test(same.text), same.text.trim());
  const busy = run([0, 7, 15].map((k) => queued(k, { load1: 6 })));
  ok('shedding: on a busy machine the finding is info, timing unreliable, and skipped, not failed', busy.code === 0 && /SKIP  L12 express load planted: .*timing unreliable/.test(busy.text) && busy.planted?.findings[0]?.severity === 'info', busy.text.trim());
  const hot = run([0, 7, 15].map((k) => queued(k, { load1: 0.5, cooled: false })));
  ok('  a step whose load average never cooled is unreliable too (docs/decisions.md, Q6)', hot.code === 0 && /SKIP/.test(hot.text), hot.text.trim());
  const broken = run([0, 7, 15].map((k) => { const q = queued(k); q.clean.steps[0] = step('below', 50, 15, [300, 450, 0, 0]); return q; }));
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
  const decoy = run((k) => [step('getOrder', '/orders/:id', 90 + k), ...held(k).slice(1)], released);
  ok('  a decoy step that fails in the planted twin only is a false positive', decoy.code === 1 && /decoy reported: pool-exhaustion STB-09 getOrder/.test(decoy.text), decoy.text);
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
