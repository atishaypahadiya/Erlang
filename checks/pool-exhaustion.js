// pool-exhaustion (STB-08, STB-09; fixture L08): connections checked out of
// a pg pool that are not returned on every path, or that are held while the
// code waits on another service. Static: reads source, runs nothing.
//
// A checkout is `await pool.connect()` on a pg Pool (pg's Pool, pg-pool),
// assigned to a variable, in code a request handler reaches. pg's Client is
// not a pool, and pool.query() returns its connection itself.
//
// Reported:
//   - STB-08, error: the client is not released on every path. Released on
//     every path means client.release() in a finally block whose try holds
//     the checkout or comes right after it; or in .finally() on a promise;
//     or both in a catch and at the end of the try, with no return or throw
//     before it.
//   - STB-09, warning: between the checkout and the last release, the code
//     awaits a call to another service: fetch, axios, got or node:http, made
//     directly or through the project's helpers (lib/outbound.js).
// Not judged (counted in the run data): the callback form
// pool.connect((err, client, done) => ...); a checkout not assigned to a
// variable; a client not released on every path that is handed to another
// function or returned, since the code that receives it may own the release.
// With no request handler found, every finding is info.
//
// Fixes: a missing release is fixed automatically when the checkout is a
// declaration in a block and its only release, if any, is a statement of
// that block: every statement after the checkout but the release is wrapped
// in try, with the release in finally. Otherwise, and for a connection held
// across a call, the fix is guided, and names every line from the checkout
// to the call.

import { ts, build, position, relOf } from '../lib/program.js';
import { unwrap, declOf, origin, isLib, symbolAt, functionName, evalObject, lookup } from '../lib/resolve.js';
import { readSources } from '../lib/sources.js';
import { perFile } from '../lib/isolate.js';
import { findHandlers } from '../lib/handlers.js';
import { outboundOf } from '../lib/outbound.js';
import { finding, fingerprint } from '../core/finding.js';

export const CHECK = 'pool-exhaustion';
const MAX_DEPTH = 6;
const PG_DEFAULT_MAX = 10;
const LEAK_NOTE = 'Release the client in a finally block, so an error cannot keep it: const client = await pool.connect(); try { ... } finally { client.release(); } (node-postgres, STB-08).';
const HELD_NOTE = 'Call the other service before taking the connection, or after releasing it, and hold the connection only for the queries (STB-09). If the call must sit inside a transaction, keep its timeout short (TMO-04).';

export function run(root, { handlers: brief = [] } = {}) {
  const { files, gaps } = readSources(root);
  const cx = { ...build(files), files };
  const rels = [...files.keys()].sort();
  const H = findHandlers(cx, rels, gaps, brief);
  const stats = { files: files.size, handlers: H.handlers.length, checkouts: 0, releasedEveryPath: 0, skipped: { callbackForm: 0, unassigned: 0, handedOff: 0, outsideRequests: 0 }, notes: H.notes };
  const findings = [];

  // A pg pool: new Pool(...) from pg or pg-pool, followed through variables
  // and awaits; or a parameter typed Pool. Gives { node } (the new
  // expression, when there is one) or null.
  function poolOf(e, depth = 0) {
    e = unwrap(e);
    if (!e || depth > MAX_DEPTH) return null;
    if (ts.isAwaitExpression(e)) return poolOf(e.expression, depth + 1);
    if (ts.isNewExpression(e)) {
      const o = origin(cx, e.expression);
      return isLib(o, 'pg', 'Pool') || (o.k === 'import' && o.module === 'pg' && o.path.join('.') === 'Pool') || isLib(o, 'pg-pool') ? { node: e } : null;
    }
    if (!ts.isIdentifier(e)) return null;
    const d = declOf(cx, e)?.decl;
    if (d && ts.isVariableDeclaration(d) && d.initializer) return poolOf(d.initializer, depth + 1);
    return d && ts.isParameter(d) && d.type && /\bPool\b/.test(d.type.getText()) ? { node: null } : null;
  }

  // The pool's size: its max option, or pg's default of 10.
  function sizeOf(pool) {
    const opts = pool.node?.arguments?.[0];
    const v = opts ? lookup(evalObject(cx, opts), 'max') : { absent: true };
    const e = unwrap(v.value);
    if (e && ts.isNumericLiteral(e)) return `its ${Number(e.text.replaceAll('_', ''))} connections`;
    return pool.node && v.absent ? `its ${PG_DEFAULT_MAX} connections (pg's default)` : 'its connections';
  }

  const checkouts = [];
  for (const rel of rels) {
    perFile(gaps, rel, () => {
      const visit = (n) => {
        if (ts.isCallExpression(n)) {
          const c = unwrap(n.expression);
          if (ts.isPropertyAccessExpression(c) && c.name.text === 'connect') {
            const pool = poolOf(c.expression);
            if (pool) checkouts.push({ call: n, pool });
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(cx.sourceFile(rel));
    });
  }

  const parentOf = (n) => { let p = n.parent; while (p && ts.isParenthesizedExpression(p)) p = p.parent; return p; };
  const enclosingFunction = (node) => { for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n; return node.getSourceFile(); };
  const within = (n, outer) => !!outer && n.getStart() >= outer.getStart() && n.end <= outer.end;
  const statementOf = (n) => { let s = n; while (s.parent && !ts.isBlock(s.parent) && !ts.isSourceFile(s.parent)) s = s.parent; return s; };

  // The variable a checkout is assigned to: `const client = await
  // pool.connect()` or `client = await pool.connect()`.
  function boundTo(call) {
    const aw = parentOf(call);
    if (!aw || !ts.isAwaitExpression(aw)) return null;
    const p = parentOf(aw);
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return { decl: p, statement: statementOf(p) };
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(p.left)) {
      const d = declOf(cx, p.left)?.decl;
      return d && ts.isVariableDeclaration(d) ? { decl: d, statement: statementOf(p) } : null;
    }
    return null;
  }

  function usesOf(decl, fn) {
    const out = [];
    const visit = (n) => {
      if (ts.isIdentifier(n) && n !== decl.name && n.text === decl.name.text && declOf(cx, n)?.decl === decl) out.push(n);
      ts.forEachChild(n, visit);
    };
    visit(fn);
    return out;
  }
  const releaseCall = (use) => {
    const p = parentOf(use);
    if (!ts.isPropertyAccessExpression(p) || p.expression !== use || p.name.text !== 'release') return null;
    const call = parentOf(p);
    return ts.isCallExpression(call) && unwrap(call.expression) === p ? call : null;
  };
  // A use that gives the client to other code, which then owns its release.
  function handedOff(use) {
    const p = parentOf(use);
    if (ts.isCallExpression(p) && p.arguments.some((a) => unwrap(a) === use)) return true;
    if (ts.isReturnStatement(p) || ts.isArrowFunction(p) || ts.isArrayLiteralExpression(p) || ts.isShorthandPropertyAssignment(p) || (ts.isPropertyAssignment(p) && p.initializer === use)) return true;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === use) return true;
    if (ts.isVariableDeclaration(p) && p.initializer === use) return true;
    return false;
  }
  const exits = (block, before) => {
    let found = false;
    const visit = (n) => {
      if (found || n.getStart() >= before || (ts.isFunctionLike(n) && n !== block)) return;
      if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) found = true;
      else ts.forEachChild(n, visit);
    };
    visit(block);
    return found;
  };
  const nextStatement = (s) => { const list = s.parent?.statements; const i = list ? list.indexOf(s) : -1; return i >= 0 ? list[i + 1] : undefined; };

  // Whether the client is released on every path.
  function releasedEveryPath(call, statement, releases) {
    const covers = (t) => within(call, t.tryBlock) || nextStatement(statement) === t;
    for (const r of releases) {
      for (let n = r.parent; n; n = n.parent) {
        if (ts.isTryStatement(n) && within(r, n.finallyBlock) && covers(n)) return true;
        if (ts.isFunctionLike(n)) {
          const host = parentOf(n);
          if (ts.isCallExpression(host) && ts.isPropertyAccessExpression(unwrap(host.expression)) && unwrap(host.expression).name.text === 'finally') return true;
          break;
        }
      }
    }
    for (const r of releases) {
      const t = r.parent?.parent;
      if (!ts.isExpressionStatement(r.parent) || !t || !ts.isBlock(t) || !ts.isTryStatement(t.parent) || t.parent.tryBlock !== t) continue;
      const tr = t.parent;
      if (covers(tr) && tr.catchClause && releases.some((x) => within(x, tr.catchClause.block)) && !exits(tr.tryBlock, r.getStart())) return true;
    }
    return false;
  }

  function locationOf(node) {
    const anchor = ts.isCallExpression(node) ? node.expression : node;
    const p = position(anchor);
    const symbol = symbolAt(node);
    return { file: relOf(node.getSourceFile().fileName), line: p.line, column: p.column, ...(symbol ? { symbol } : {}) };
  }
  const lineOnly = (n) => { const l = locationOf(n); return { file: l.file, line: l.line }; };
  // Every line from one node to the other: moving a call before the checkout
  // moves the lines between them too.
  const span = (a, b) => {
    const [x, y] = [lineOnly(a), lineOnly(b)].sort((p, q) => p.line - q.line);
    return Array.from({ length: y.line - x.line + 1 }, (_, k) => ({ file: x.file, line: x.line + k }));
  };
  const indentOf = (node) => {
    const sf = node.getSourceFile();
    const start = sf.getLineAndCharacterOfPosition(node.getStart()).line;
    return /^[ \t]*/.exec(sf.text.slice(sf.getLineStarts()[start]))[0];
  };

  // The auto fix: wrap what follows the checkout in try, release in finally.
  function wrapFix(statement, decl, releases) {
    if (!ts.isVariableStatement(statement) || !ts.isBlock(statement.parent) || !statement.declarationList.declarations.includes(decl)) return null;
    const list = statement.parent.statements;
    const rest = list.slice(list.indexOf(statement) + 1);
    if (releases.length > 1) return null;
    const r = releases[0]?.parent;
    if (r && (!ts.isExpressionStatement(r) || !rest.includes(r))) return null;
    const body = rest.filter((s) => s !== r);
    if (!body.length) return null;
    const sf = statement.getSourceFile();
    const start = body[0].getStart();
    const end = rest.at(-1).end;
    const indent = indentOf(statement);
    let text = sf.text.slice(start, end);
    if (r) text = text.slice(0, r.getFullStart() - start) + text.slice(r.end - start);
    const inner = text.replace(/\n(?=[ \t]*\S)/g, '\n  ');
    const p = sf.getLineAndCharacterOfPosition(start);
    return {
      kind: 'auto',
      edits: [{ file: relOf(sf.fileName), line: p.line + 1, column: p.character + 1, length: end - start,
        replace: `try {\n${indent}  ${inner}\n${indent}} finally {\n${indent}  ${decl.name.text}.release();\n${indent}}` }],
      note: 'The statements after the checkout are wrapped in try, and the client is released in finally, so an error cannot keep it (STB-08).',
    };
  }

  function judge({ call, pool }) {
    stats.checkouts++;
    if (call.arguments.length) { stats.skipped.callbackForm++; return; }
    const bound = boundTo(call);
    if (!bound) { stats.skipped.unassigned++; return; }
    const reach = H.reach(call);
    if (H.handlers.length && !reach.length) { stats.skipped.outsideRequests++; return; }
    const fn = enclosingFunction(call);
    const uses = usesOf(bound.decl, fn);
    const releases = uses.map(releaseCall).filter(Boolean);
    const released = releasedEveryPath(call, bound.statement, releases);
    if (!released && uses.some(handedOff)) { stats.skipped.handedOff++; return; }
    const endpoints = [...new Map(reach.filter((h) => h.endpoint).map((h) => [h.label, h.endpoint])).values()];
    const at = reach.length ? ` to ${[...new Set(reach.map((h) => h.label))].join(' and ')}` : '';
    let named;
    for (let n = call.parent; n && !named; n = n.parent) if (ts.isFunctionLike(n)) named = functionName(n);
    const who = named ?? (reach.length ? `The ${reach[0].label} handler` : 'Module code');
    const name = bound.decl.name.text;
    const checkout = locationOf(call);
    const unsure = H.handlers.length ? null : ' ERLANG found no request handler, so whether a request runs this is unknown (name entry points under handlers in erlang.config.json).';
    const base = { endpoints, unsure };

    if (released) stats.releasedEveryPath++;
    else {
      const how = releases.length
        ? `releases it only on some paths (${releases.map((r) => `line ${locationOf(r).line}`).join(', ')}): an error or early return before that leaves it checked out`
        : 'never releases it';
      findings.push({ ...base, rule: 'STB-08', strength: 'MUST', severity: 'error', keyParts: [`${checkout.file}#${checkout.symbol ?? '<module>'}`, 'not-released'],
        locations: [checkout, ...releases.map(locationOf)],
        message: `${who} checks a connection out of the pool (${name} = await ${call.expression.getText()}()) and ${how}. Each request${at} that takes that path keeps a connection for good; once ${sizeOf(pool)} are kept, every request that needs one waits forever (node-postgres; STB-08).`,
        fix: wrapFix(bound.statement, bound.decl, releases) ?? { kind: 'guided', locations: [lineOnly(call), ...releases.map(lineOnly)], note: LEAK_NOTE },
        extension: {} });
    }

    // Awaits between the checkout and the last release.
    const end = releases.length ? Math.max(...releases.map((r) => r.end)) : fn.end;
    let held = null;
    const visit = (n) => {
      if (held || (ts.isFunctionLike(n) && n !== fn)) return;
      if (ts.isAwaitExpression(n) && n.getStart() >= call.end && n.end <= end) {
        const scan = (m) => {
          if (held || (ts.isFunctionLike(m) && !ts.isArrowFunction(m))) return;
          if (ts.isCallExpression(m)) {
            const c = unwrap(m.expression);
            const onClient = ts.isPropertyAccessExpression(c) && ts.isIdentifier(unwrap(c.expression)) && declOf(cx, unwrap(c.expression))?.decl === bound.decl;
            const out = onClient ? null : outboundOf(cx, m);
            if (out) { held = { at: m, client: out.client, direct: out.call === m }; return; }
          }
          ts.forEachChild(m, scan);
        };
        scan(n.expression);
      }
      ts.forEachChild(n, visit);
    };
    visit(fn);
    if (held) {
      const callee = unwrap(held.at.expression).getText();
      const via = held.direct ? `${callee}(...), with ${held.client}` : `${callee}(...), which calls ${held.client}`;
      findings.push({ ...base, rule: 'STB-09', strength: 'SHOULD', severity: 'warning', keyParts: [`${checkout.file}#${checkout.symbol ?? '<module>'}`, 'held-across-call'],
        locations: [locationOf(held.at), checkout],
        message: `${who} holds a connection from the pool (${name}, taken at line ${checkout.line}) while it waits on another service: ${via}. Every connection in use then also waits for that service, so when it slows, ${sizeOf(pool)} run out while the database is idle (STB-09).`,
        fix: { kind: 'guided', locations: span(held.at, call), note: HELD_NOTE },
        extension: { across: held.client } });
    }
  }

  for (const c of checkouts) perFile(gaps, relOf(c.call.getSourceFile().fileName), () => judge(c));

  const counts = new Map();
  const out = findings.map((f) => {
    const fp = fingerprint(CHECK, ...f.keyParts);
    const n = (counts.get(fp) ?? 0) + 1;
    counts.set(fp, n);
    return finding({
      specialist: 'erlang',
      check: CHECK,
      severity: f.unsure ? 'info' : f.severity,
      fingerprint: n === 1 ? fp : `${fp}|${n}`,
      message: f.message + (f.unsure ?? ''),
      detection: ['static'],
      rules: [f.rule],
      where: { locations: f.locations, ...(f.endpoints.length ? { endpoints: f.endpoints } : {}) },
      extension: { strength: f.strength, client: 'pg', ...f.extension, ...(f.unsure ? { unresolved: true } : {}), fix: f.fix },
    });
  });
  return { findings: out, run: stats };
}
