// blocking-work (OVL-12; fixture L09): synchronous I/O and CPU-heavy
// synchronous calls in code a request handler reaches. While one runs, the
// process serves no other request. Static: reads source, runs nothing.
//
// Reported, from Node's list of synchronous APIs a server should not use
// (S37) and bcrypt's README (S38):
//   - node:crypto pbkdf2Sync, scryptSync, generateKeyPairSync,
//     generatePrimeSync, randomFillSync, and randomBytes with no callback,
//     unless its size is a literal of at most 1024 bytes;
//   - node:zlib, every *Sync function;
//   - node:fs, every *Sync function;
//   - node:child_process execSync, execFileSync and spawnSync;
//   - bcrypt (the native package) hashSync and compareSync;
//   - bcryptjs hash, compare, hashSync and compareSync at a cost of 10 or
//     more, asynchronous forms included: bcryptjs is pure JavaScript, so its
//     asynchronous form does the same work on the request thread, in slices
//     of up to 100 ms (bcryptjs 3.0.3, MAX_EXECUTION_TIME; measured by the
//     L09 trace). The cost is the rounds argument, a genSalt(N) call (10
//     when N is left out) or a literal salt, through a const. compare reads
//     its cost from the stored hash: the cost of the hashes the project
//     stores under the same name (compare(p, user.legacyHash) and
//     legacyHash = hash(p, 12)), or else the highest cost it hashes with.
//     A cost that cannot be found is info. Fixes are guided only.
// Only code a request handler reaches is judged. With no request handler
// found, nothing is reported: synchronous calls are ordinary in scripts and
// command-line tools, and the run data says so.
//
// Fixes are auto when the call sits directly in an async function and goes
// through the module's default or namespace import: the asynchronous form,
// awaited (crypto and zlib through their callbacks, bcrypt's promise,
// fs.promises). Otherwise guided: a named import, existsSync and other fs
// calls with no promise form, child_process, or a call in a function that
// is not async; the guided fix names the import too.

import { ts, build, position, relOf } from '../lib/program.js';
import { unwrap, origin, symbolAt, functionName } from '../lib/resolve.js';
import { readSources } from '../lib/sources.js';
import { perFile } from '../lib/isolate.js';
import { findHandlers } from '../lib/handlers.js';
import { finding, fingerprint } from '../core/finding.js';

export const CHECK = 'blocking-work';
const SMALL_RANDOM = 1024;

const CRYPTO = { pbkdf2Sync: 'pbkdf2', scryptSync: 'scrypt', generateKeyPairSync: 'generateKeyPair', generatePrimeSync: 'generatePrime', randomFillSync: 'randomFill', randomBytes: 'randomBytes' };
const CHILD = new Set(['execSync', 'execFileSync', 'spawnSync']);
const BCRYPT = { hashSync: 'hash', compareSync: 'compare' };
const BCRYPTJS = new Set(['hash', 'compare', 'hashSync', 'compareSync']);
const BCRYPTJS_COST = 10;
const BCRYPTJS_DEFAULT = 10;
const FS_PROMISES = new Set(['readFile', 'writeFile', 'appendFile', 'readdir', 'stat', 'lstat', 'mkdir', 'mkdtemp', 'unlink', 'rm', 'rmdir', 'copyFile', 'cp', 'rename', 'access', 'realpath', 'readlink', 'chmod', 'utimes', 'truncate', 'symlink', 'link']);
const WHY = {
  pbkdf2Sync: 'key derivation is slow by design, and the synchronous form runs on the request thread',
  scryptSync: 'key derivation is slow by design, and the synchronous form runs on the request thread',
  generateKeyPairSync: 'generating a key pair takes a long time, on the request thread',
  generatePrimeSync: 'searching for a prime takes a long time, on the request thread',
  randomFillSync: 'it fills the whole buffer on the request thread',
  randomBytes: 'without a callback, it makes every byte on the request thread',
  compress: 'it compresses the whole input on the request thread',
  decompress: 'it decompresses the whole input on the request thread, and its size is the sender\'s to choose',
  fs: 'it waits on the disk on the request thread',
  child_process: 'it waits for the whole child process on the request thread',
  bcrypt: 'bcrypt is slow by design, and the synchronous form runs on the request thread',
};
const GUIDED_NOTE = {
  crypto: 'Use the callback form, which runs on the worker pool (crypto.pbkdf2, crypto.scrypt, ...), promisified and awaited, or move the work to a worker thread (OVL-12).',
  zlib: 'Take the compression off the main thread, one of two ways: the callback or stream form, which runs on the worker pool (zlib.gzip, zlib.createGzip), awaited; or a worker thread (node:worker_threads) that compresses and returns one buffer, which also keeps the output\'s chunks, and the garbage collections they cause, off the main thread for a large input (OVL-12).',
  fs: 'Use node:fs/promises and await it, or read the file once at startup if it does not change (OVL-12). existsSync has no promise form: use fs.promises.access, or open the file and handle ENOENT.',
  child_process: 'Use execFile or spawn, promisified or with their events, so the request thread is free while the child runs (OVL-12).',
  bcrypt: 'Use bcrypt.hash and bcrypt.compare, which return promises, and await them (OVL-12).',
  bcryptjs: 'Hash off the request thread: Node\'s crypto.scrypt (its callback form runs on the worker pool), the native bcrypt package, or bcryptjs in a worker thread. Existing bcrypt hashes need a migration path: verify a login with the old hash, then re-hash the password with the new scheme and store it, so each account moves over at its next login (OVL-12).',
};

export function run(root, { handlers: brief = [] } = {}) {
  const { files, gaps } = readSources(root);
  const cx = { ...build(files), files };
  const rels = [...files.keys()].sort();
  const H = findHandlers(cx, rels, gaps, brief);
  const stats = { files: files.size, handlers: H.handlers.length, calls: 0, skipped: { outsideRequests: 0, smallRandom: 0, noHandlers: 0 }, notes: [...H.notes] };
  const findings = [];

  // What a call is: { kind, module, name, ns, imp } or null. ns is the
  // default or namespace import's local text (crypto in crypto.pbkdf2Sync).
  function blockingOf(call) {
    const o = origin(cx, call.expression);
    if (o.k !== 'import' || !o.path?.length) return null;
    const module = o.module.replace(/^node:/, '');
    const name = o.path.at(-1);
    const viaNs = o.path.length === 2 && (o.path[0] === 'default' || o.path[0] === '*');
    if (o.path.length > 2 || (o.path.length === 2 && !viaNs)) return null;
    let kind = null;
    if (module === 'crypto' && name in CRYPTO) kind = 'crypto';
    else if (module === 'zlib' && name.endsWith('Sync')) kind = 'zlib';
    else if (module === 'fs' && name.endsWith('Sync')) kind = 'fs';
    else if (module === 'child_process' && CHILD.has(name)) kind = 'child_process';
    else if (module === 'bcrypt' && name in BCRYPT) kind = 'bcrypt';
    else if (module === 'bcryptjs' && BCRYPTJS.has(name)) kind = 'bcryptjs';
    if (!kind) return null;
    const callee = unwrap(call.expression);
    const ns = viaNs && ts.isPropertyAccessExpression(callee) ? callee.expression.getText() : null;
    return { kind, module: o.module, name, ns, imp: importOf(callee) };
  }

  // The import declaration a callee's name comes from, in this file.
  function importOf(callee) {
    const id = ts.isPropertyAccessExpression(callee) ? unwrap(callee.expression) : callee;
    if (!ts.isIdentifier(id)) return null;
    const s = cx.checker.getSymbolAtLocation(id);
    for (const d of s?.declarations ?? []) {
      for (let n = d; n; n = n.parent) {
        if (ts.isImportDeclaration(n)) return n;
        if (ts.isVariableStatement(n)) return n;
        if (ts.isSourceFile(n)) break;
      }
    }
    return null;
  }

  // bcryptjs's cost: the rounds, from a number, a genSalt(N) call or a salt
  // string; null when it cannot be read.
  function costOf(arg, depth = 0) {
    const a = unwrap(arg);
    if (!a) return null;
    if (ts.isNumericLiteral(a)) return Number(a.text.replaceAll('_', ''));
    if (ts.isStringLiteralLike(a)) { const m = /^\$2[abxy]?\$(\d\d)\$/.exec(a.text); return m ? Number(m[1]) : null; }
    if (ts.isAwaitExpression(a)) return costOf(a.expression, depth);
    if (ts.isCallExpression(a)) {
      const o = origin(cx, a.expression);
      if (o.k === 'import' && o.module === 'bcryptjs' && ['genSalt', 'genSaltSync'].includes(o.path?.at(-1))) return a.arguments.length && !ts.isFunctionLike(unwrap(a.arguments[0])) ? costOf(a.arguments[0], depth) : BCRYPTJS_DEFAULT;
      return null;
    }
    if (ts.isIdentifier(a) && depth < 2) {
      const d = cx.checker.getSymbolAtLocation(a)?.declarations?.[0];
      if (d && ts.isVariableDeclaration(d) && d.initializer && (ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const)) return costOf(d.initializer, depth + 1);
    }
    return null;
  }
  // The costs the project hashes with through bcryptjs: the highest overall,
  // and the highest per name the hash is stored under (a variable or a
  // property). null when none is known.
  let hashing;
  const nameOf = (n) => (n && (ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteral(n)) ? n.text : null);
  function storedUnder(call) {
    let n = call;
    while (n.parent && (ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent))) n = n.parent;
    const p = n.parent;
    if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && p.initializer === n) return nameOf(p.name);
    if (p && ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return ts.isPropertyAccessExpression(p.left) ? p.left.name.text : nameOf(p.left);
    return null;
  }
  function hashingCosts() {
    if (hashing) return hashing;
    hashing = { max: null, byName: new Map() };
    for (const rel of rels) {
      const visit = (n) => {
        if (ts.isCallExpression(n)) {
          const o = origin(cx, n.expression);
          if (o.k === 'import' && o.module === 'bcryptjs' && ['hash', 'hashSync'].includes(o.path?.at(-1))) {
            const c = costOf(n.arguments[1]);
            if (c !== null) {
              hashing.max = Math.max(hashing.max ?? 0, c);
              const name = storedUnder(n);
              if (name) hashing.byName.set(name, Math.max(hashing.byName.get(name) ?? 0, c));
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      try { visit(cx.sourceFile(rel)); } catch { /* an unreadable file adds nothing */ }
    }
    return hashing;
  }
  // compare's cost: that of the hashes stored under the name it reads.
  function compareCost(call) {
    const h = hashingCosts();
    const a = unwrap(call.arguments[1]);
    const name = !a ? null : ts.isPropertyAccessExpression(a) ? a.name.text : ts.isElementAccessExpression(a) ? nameOf(unwrap(a.argumentExpression)) : nameOf(a);
    return (name && h.byName.get(name)) ?? h.max;
  }
  const bcryptjsCost = (b, call) => (b.name.startsWith('hash') ? costOf(call.arguments[1]) : compareCost(call));

  function whyOf(b) {
    if (b.kind === 'crypto') return WHY[b.name];
    if (b.kind === 'zlib') return WHY[/^(gunzip|inflate|unzip|brotliDecompress|zstdDecompress)/.test(b.name) ? 'decompress' : 'compress'];
    return WHY[b.kind];
  }

  // randomBytes with a callback runs on the worker pool; with a small
  // literal size, the synchronous form is quick.
  function quick(b, call) {
    if (b.name !== 'randomBytes') return false;
    if (call.arguments.length >= 2) return true;
    const size = unwrap(call.arguments[0]);
    if (size && ts.isNumericLiteral(size) && Number(size.text.replaceAll('_', '')) <= SMALL_RANDOM) { stats.skipped.smallRandom++; return true; }
    return false;
  }

  const enclosingFunction = (node) => { for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n; return null; };
  const isAsync = (fn) => !!fn?.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);

  function locationOf(node) {
    const anchor = ts.isCallExpression(node) ? node.expression : node;
    const p = position(anchor);
    const symbol = symbolAt(node);
    return { file: relOf(node.getSourceFile().fileName), line: p.line, column: p.column, ...(symbol ? { symbol } : {}) };
  }
  const lineOnly = (n) => { const l = locationOf(n); return { file: l.file, line: l.line }; };

  // The asynchronous form, awaited, in place of the call; or null.
  function asyncText(b, call) {
    if (!b.ns) return null;
    const args = call.arguments.map((a) => a.getText());
    const viaCallback = (fn, result) => `(await new Promise((resolve, reject) => ${b.ns}.${fn}(${[...args, result].join(', ')})))`;
    if (b.kind === 'crypto') {
      const fn = CRYPTO[b.name];
      if (fn === 'generateKeyPair') return viaCallback(fn, '(err, publicKey, privateKey) => (err ? reject(err) : resolve({ publicKey, privateKey }))');
      return viaCallback(fn, '(err, result) => (err ? reject(err) : resolve(result))');
    }
    if (b.kind === 'zlib') return viaCallback(b.name.slice(0, -4), '(err, result) => (err ? reject(err) : resolve(result))');
    if (b.kind === 'bcrypt') return `(await ${b.ns}.${BCRYPT[b.name]}(${args.join(', ')}))`;
    if (b.kind === 'fs') {
      const fn = b.name.slice(0, -4);
      return FS_PROMISES.has(fn) ? `(await ${b.ns}.promises.${fn}(${args.join(', ')}))` : null;
    }
    return null;
  }

  function fixOf(b, call) {
    const text = b.kind !== 'bcryptjs' && isAsync(enclosingFunction(call)) ? asyncText(b, call) : null;
    if (text) {
      const sf = call.getSourceFile();
      const p = sf.getLineAndCharacterOfPosition(call.getStart());
      return {
        kind: 'auto',
        edits: [{ file: relOf(sf.fileName), line: p.line + 1, column: p.character + 1, length: call.end - call.getStart(), replace: text }],
        note: `The call is replaced by its asynchronous form, awaited, so the work runs off the request thread (OVL-12).${b.kind === 'crypto' || b.kind === 'zlib' ? ' The worker pool has 4 threads by default (UV_THREADPOOL_SIZE): heavy use queues there instead, so measure it under load.' : ''}${b.kind === 'zlib' ? ' The other way to take compression off the main thread is a worker thread (node:worker_threads) that compresses and returns one buffer: the asynchronous form still hands its output back to the main thread in chunks, which for a large input costs the main thread allocations and garbage collections that a worker keeps off it.' : ''}`,
      };
    }
    const locations = [lineOnly(call)];
    if (b.imp && b.imp.getSourceFile() === call.getSourceFile() && !b.ns) locations.push(lineOnly(b.imp));
    return { kind: 'guided', locations, note: GUIDED_NOTE[b.kind] };
  }

  for (const rel of rels) {
    perFile(gaps, rel, () => {
      const visit = (n) => {
        if (ts.isCallExpression(n)) {
          const b = blockingOf(n);
          const cost = b?.kind === 'bcryptjs' ? bcryptjsCost(b, n) : null;
          if (b?.kind === 'bcryptjs' && cost !== null && cost < BCRYPTJS_COST) stats.skipped.lowCost = (stats.skipped.lowCost ?? 0) + 1;
          else if (b && !quick(b, n)) {
            stats.calls++;
            const reach = H.reach(n);
            if (!H.handlers.length) stats.skipped.noHandlers++;
            else if (!reach.length) stats.skipped.outsideRequests++;
            else {
              let named;
              for (let m = n.parent; m && !named; m = m.parent) if (ts.isFunctionLike(m)) named = functionName(m);
              const who = named ?? `The ${reach[0].label} handler`;
              const labels = [...new Set(reach.map((h) => h.label))];
              const endpoints = [...new Map(reach.filter((h) => h.endpoint).map((h) => [h.label, h.endpoint])).values()];
              const callee = unwrap(n.expression).getText();
              const loc = locationOf(n);
              findings.push({
                keyParts: [`${loc.file}#${loc.symbol ?? '<module>'}`, `${b.module}.${b.name}`],
                locations: [loc], endpoints,
                message: b.kind === 'bcryptjs'
                  ? `${who} calls ${callee}()${b.name.endsWith('Sync') ? ', synchronous,' : ''} in code that ${labels.join(' and ')} run${labels.length > 1 ? '' : 's'}, ${cost === null ? 'at a cost ERLANG cannot read' : `at cost ${cost} (2^${cost} rounds)`}. bcryptjs is pure JavaScript: ${b.name.endsWith('Sync') ? 'the whole hash runs' : 'even its asynchronous form runs the whole hash'} on the request thread${b.name.endsWith('Sync') ? '' : ', in slices of up to 100 ms with a yield between them (bcryptjs 3.0.3)'}, so the process serves fewer requests while it hashes, and a client that sends many logins can stall the service (OVL-12).${cost === null ? ' At a cost of 10 or more this is a warning.' : ''}`
                  : `${who} calls ${callee}(), synchronous, in code that ${labels.join(' and ')} run${labels.length > 1 ? '' : 's'}: ${whyOf(b)}. While it runs, the process serves no other request, so every request waits behind it, and a client that can make it slow can stall the service (Node.js, "Don't Block the Event Loop"; OVL-12).`,
                fix: fixOf(b, n),
                blocking: b.kind,
                unresolved: b.kind === 'bcryptjs' && cost === null,
              });
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(cx.sourceFile(rel));
    });
  }
  if (!H.handlers.length && stats.calls) stats.notes.push('No request handler was found, so synchronous calls were not judged: in scripts and tools they block nothing that matters. Name entry points under handlers in erlang.config.json to judge them.');

  const counts = new Map();
  const out = findings.map((f) => {
    const fp = fingerprint(CHECK, ...f.keyParts);
    const n = (counts.get(fp) ?? 0) + 1;
    counts.set(fp, n);
    return finding({
      specialist: 'erlang',
      check: CHECK,
      severity: f.unresolved ? 'info' : 'warning',
      fingerprint: n === 1 ? fp : `${fp}|${n}`,
      message: f.message,
      detection: ['static'],
      rules: ['OVL-12'],
      where: { locations: f.locations, ...(f.endpoints.length ? { endpoints: f.endpoints } : {}) },
      extension: { strength: 'SHOULD', blocking: f.blocking, fix: f.fix },
    });
  });
  return { findings: out, run: stats };
}
