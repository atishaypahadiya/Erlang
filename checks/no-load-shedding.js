// no-load-shedding (OVL-02, OVL-03; fixture L12): an app that takes every
// request it is sent, with nothing that caps the requests in flight.
// Static: reads source and proxy configuration, runs nothing.
//
// Reported, as a warning, once per Express, Fastify or node:http server in
// a project with request handlers, when none of these bounds it:
//   - a limiter applied to that app: a middleware (app.use), hook
//     (app.addHook) or plugin (app.register) whose function, or the function
//     that makes it, answers 503 or 429 and compares something (a count of
//     requests in flight, a queue length, a delay); @fastify/under-pressure
//     registered; express-queue with a queuedLimit;
//   - the server's maxConnections set (OVL-11), on the server createServer
//     made or the one the app's listen() returned; set on a server that
//     cannot be followed, it counts for every app;
//   - a proxy file in the repository that limits connections: nginx
//     limit_conn or max_conns, HAProxy maxconn.
// A limit set in a proxy or platform outside the repository is unknown, so
// the message says so.
//
// The fix is guided: what to cap, and at what number, is found by a load
// test (CAP-02).

import { ts, build, position, relOf } from '../lib/program.js';
import { unwrap, origin, isLib, declOf, symbolAt } from '../lib/resolve.js';
import { readSources } from '../lib/sources.js';
import { perFile } from '../lib/isolate.js';
import { findHandlers } from '../lib/handlers.js';
import { proxyFiles } from '../lib/proxies.js';
import { finding, fingerprint } from '../core/finding.js';

export const CHECK = 'no-load-shedding';
const PRESSURE = new Set(['@fastify/under-pressure', 'under-pressure']);
const BUSY = new Set(['toobusy-js', 'overload-protection']);
const REFUSALS = new Set([503, 429]);
const MAX_DEPTH = 2;
const NOTE = {
  express: 'Put a middleware before the routes that counts requests in flight and answers 503 with Retry-After once the count reaches a cap (let inFlight = 0; if (inFlight >= cap) return res.status(503).set(\'retry-after\', \'1\').end(); inFlight++; res.on(\'close\', () => inFlight--)). Find the cap with a load test stepped past the knee (CAP-02): the most requests in flight at which latency still meets its target (OVL-02).',
  fastify: 'Register @fastify/under-pressure right after the app is made (app.register(underPressure, { maxEventLoopDelay: 1000 })), or add an onRequest hook that counts requests in flight and answers 503 over a cap. Find the cap with a load test stepped past the knee (CAP-02) (OVL-02).',
  'node:http': 'Set server.maxConnections no higher than the server can serve (OVL-11), and count requests in flight in the request listener, answering 503 over a cap (OVL-02). Find the cap with a load test stepped past the knee (CAP-02).',
};

export function run(root, { handlers: brief = [] } = {}) {
  const { files, gaps } = readSources(root);
  const cx = { ...build(files), files };
  const rels = [...files.keys()].sort();
  const H = findHandlers(cx, rels, gaps, brief);
  const stats = { files: files.size, handlers: H.handlers.length, apps: 0, limited: [], maxConnections: [], proxyLimits: [], notes: [...H.notes] };
  const findings = [];

  const lineOf = (n) => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const fileOf = (n) => relOf(n.getSourceFile().fileName);
  const statementOf = (n) => { let s = n; while (s.parent && !ts.isBlock(s.parent) && !ts.isSourceFile(s.parent)) s = s.parent; return s; };
  // The declaration an expression names, through parentheses.
  const declOfExpr = (e) => { e = unwrap(e); return e && ts.isIdentifier(e) ? declOf(cx, e)?.decl ?? null : null; };

  // The function an argument stands for: a function, a named function, or
  // the function a factory call runs (its body holds the middleware).
  function functionOf(e) {
    e = unwrap(e);
    if (!e) return null;
    if (ts.isFunctionLike(e)) return e;
    if (ts.isCallExpression(e)) return functionOf(e.expression);
    if (ts.isIdentifier(e)) {
      let d = declOf(cx, e)?.decl;
      if (d && ts.isVariableDeclaration(d)) d = unwrap(d.initializer);
      return d && ts.isFunctionLike(d) ? d : null;
    }
    return null;
  }
  // Whether a function refuses work: a 503 or 429 and a comparison, or a
  // call to a busy check, in it or in the project functions it calls.
  function refuses(fn, depth = 0, seen = new Set()) {
    if (!fn || seen.has(fn)) return { status: false, test: false };
    seen.add(fn);
    const r = { status: false, test: false };
    const visit = (n) => {
      if (ts.isNumericLiteral(n) && REFUSALS.has(Number(n.text))) r.status = true;
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken].includes(n.operatorToken.kind)) r.test = true;
      if (ts.isCallExpression(n)) {
        const o = origin(cx, n.expression);
        if (o.k === 'import' && BUSY.has(o.module)) r.test = true;
        if (depth < MAX_DEPTH) {
          const inner = functionOf(n.expression);
          if (inner && relOf(inner.getSourceFile().fileName) !== null) { const x = refuses(inner, depth + 1, seen); r.status ||= x.status; r.test ||= x.test; }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body ?? fn);
    return r;
  }

  const apps = [];
  const limitedApps = new Set();
  for (const rel of rels) {
    perFile(gaps, rel, () => {
      const visit = (n) => {
        if (ts.isCallExpression(n)) {
          const o = origin(cx, n.expression);
          if (isLib(o, 'express')) apps.push({ node: n, framework: 'express' });
          else if (isLib(o, 'fastify') || (o.k === 'import' && o.module === 'fastify' && o.path.length === 1 && o.path[0] === 'fastify')) apps.push({ node: n, framework: 'fastify' });
          else if (o.k === 'import' && ['node:http', 'http', 'node:https', 'https'].includes(o.module) && o.path.at(-1) === 'createServer') apps.push({ node: n, framework: 'node:http' });
          const c = unwrap(n.expression);
          if (ts.isPropertyAccessExpression(c) && ['use', 'register', 'addHook'].includes(c.name.text)) {
            const arg = c.name.text === 'addHook' ? n.arguments[1] : n.arguments[0];
            if (arg && limits(arg, n)) { const d = declOfExpr(c.expression); if (d) limitedApps.add(d); stats.limited.push(`${fileOf(n)}:${lineOf(n)}`); }
          }
        }
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'maxConnections') {
          const app = serverApp(n.left.expression);
          if (app) limitedApps.add(app);
          else stats.maxConnections.push(`${fileOf(n)}:${lineOf(n)}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(cx.sourceFile(rel));
    });
  }
  // The app a server variable belongs to: the server itself when it is
  // made by createServer, or the app whose listen() returned it; null when
  // it cannot be followed, and then maxConnections counts for every app.
  function serverApp(e) {
    const d = declOfExpr(e);
    const init = d && ts.isVariableDeclaration(d) ? unwrap(d.initializer) : null;
    if (!init || !ts.isCallExpression(init)) return null;
    const c = unwrap(init.expression);
    if (ts.isPropertyAccessExpression(c) && c.name.text === 'listen') return declOfExpr(c.expression);
    const o = origin(cx, init.expression);
    return o.k === 'import' && o.path.at(-1) === 'createServer' ? d : null;
  }
  // Whether a middleware, hook or plugin argument limits requests.
  function limits(arg, call) {
    const o = origin(cx, arg);
    if (o.k === 'import' && PRESSURE.has(o.module)) return true;
    const a = unwrap(arg);
    if (ts.isCallExpression(a)) {
      const q = origin(cx, a.expression);
      if (q.k === 'import' && q.module === 'express-queue') {
        const opts = unwrap(a.arguments[0]);
        return !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => p.name?.getText() === 'queuedLimit' && ts.isPropertyAssignment(p) && ts.isNumericLiteral(unwrap(p.initializer)));
      }
    }
    const r = refuses(functionOf(arg));
    return r.status && r.test;
  }

  for (const { file, text } of proxyFiles(root, gaps)) if (/\blimit_conn\s+\S+\s+\d+|\bmax_conns=\d+|\bmaxconn\s+\d+/.test(text)) stats.proxyLimits.push(file);

  stats.apps = apps.length;
  const bounded = stats.maxConnections.length || stats.proxyLimits.length;
  if (!H.handlers.length && apps.length) stats.notes.push('No request handler was found, so the apps were not judged. Name entry points under handlers in erlang.config.json to judge them.');
  if (H.handlers.length && !bounded) {
    for (const app of apps) {
      const n = app.node;
      const decl = ts.isVariableDeclaration(n.parent) ? n.parent : null;
      if (decl && limitedApps.has(decl)) continue;
      // An app whose variable cannot be followed is given the benefit of a
      // limiter applied anywhere.
      if (!decl && stats.limited.length) continue;
      const sf = n.getSourceFile();
      const imports = sf.statements.filter(ts.isImportDeclaration);
      const afterImports = imports.length ? sf.getLineAndCharacterOfPosition(imports.at(-1).end).line + 2 : 1;
      const afterApp = sf.getLineAndCharacterOfPosition(statementOf(n).end).line + 2;
      const name = { express: 'Express app', fastify: 'Fastify app', 'node:http': 'HTTP server' }[app.framework];
      const p = position(n.expression);
      const symbol = symbolAt(n);
      findings.push({
        keyParts: [`${fileOf(n)}#${symbol ?? '<module>'}`, 'unbounded'],
        location: { file: fileOf(n), line: p.line, column: p.column, ...(symbol ? { symbol } : {}) },
        message: `The ${name} made here takes every request it is sent: nothing caps the requests in flight (no limiter answering 503 is applied to it, no maxConnections, and no proxy file in the repository limits connections). Past its capacity each request waits its turn (for a database connection, for the event loop), so every request is late instead of some refused at once, and goodput falls as load rises (OVL-02, OVL-03). If a proxy or platform outside the repository caps requests in flight, this is already handled there.`,
        fix: { kind: 'guided', locations: [...new Set([afterImports, lineOf(n), afterApp])].sort((a, b) => a - b).map((line) => ({ file: fileOf(n), line })), note: NOTE[app.framework] },
      });
    }
  }

  const counts = new Map();
  const out = findings.map((f) => {
    const fp = fingerprint(CHECK, ...f.keyParts);
    const k = (counts.get(fp) ?? 0) + 1;
    counts.set(fp, k);
    return finding({
      specialist: 'erlang',
      check: CHECK,
      severity: 'warning',
      fingerprint: k === 1 ? fp : `${fp}|${k}`,
      message: f.message,
      detection: ['static'],
      rules: ['OVL-02', 'OVL-03'],
      where: { locations: [f.location] },
      extension: { strength: 'SHOULD', fix: f.fix },
    });
  });
  return { findings: out, run: stats };
}
