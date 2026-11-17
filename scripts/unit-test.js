// Unit cases for what the L07 fixture does not cover: other ways of
// importing and configuring each client, the shapes a fix must handle, and
// controls for per-file isolation. Each case writes a small subject to
// dist/unit/<case>/ and scans it with no-timeout alone.
//
// Usage: node scripts/unit-test.js           exit 0 when every case holds

import { writeFileSync, mkdirSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../bin/erlang.js';
import { apply, syntaxErrors } from '../lib/fix.js';
import { describe, Plain } from '../lib/isolate.js';

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
const scanOf = (dir) => scan(dir, { only: ['no-timeout'] });
const summary = (r) => r.findings.map((f) => `${f.severity} ${f.where.locations[0].file}:${f.where.locations[0].line} ${f.erlang.fix.kind}`).join('; ') || 'none';

// expect: a list of [severity, file, line, fix kind] in report order, or [].
function expectFindings(name, files, expect) {
  const r = scanOf(subject(files));
  const got = r.findings.map((f) => [f.severity, f.where.locations[0].file, f.where.locations[0].line, f.erlang.fix.kind]);
  ok(name, r.status === 'complete' && JSON.stringify(got) === JSON.stringify(expect), `${r.status}; got ${summary(r)}`);
  return r;
}

// An auto fix must apply, parse, and leave nothing reported.
function expectAutoFixHolds(name, files) {
  const dir = subject(files);
  const before = scanOf(dir);
  const f = before.findings[0];
  if (!f || f.erlang.fix.kind !== 'auto') { ok(name, false, `no auto fix: ${summary(before)}`); return; }
  const fixed = `${dir}-fixed`;
  cpSync(dir, fixed, { recursive: true });
  apply(fixed, [f.erlang.fix]);
  const file = f.erlang.fix.edits[0].file;
  const text = readFileSync(join(fixed, file), 'utf8');
  const after = scanOf(fixed);
  ok(name, !syntaxErrors(file, text).length && after.status === 'complete' && after.findings.length === 0, `${text.trim().split('\n').find((l) => /timeout|signal/.test(l))?.trim()}; after: ${summary(after)}`);
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
