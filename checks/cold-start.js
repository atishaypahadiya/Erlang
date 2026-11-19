// cold-start (STB-10; fixture L11): set-up that every request depends on,
// done by the first request that needs it instead of at startup.
// Static: reads source, runs nothing.
//
// Reported, as a warning, in code a request handler reaches: a variable
// that outlives the request (declared at module level, or in a function no
// handler runs) assigned only when it is still unset, with work that takes
// time:
//   if (!x) x = await build();      if (x === null) { x = await build(); }
//   x ??= await import('./big.js');  x ||= build();
// Work that takes time is an await, a *Sync call or a loop, directly or in
// a function of the project's that the value comes from. A cheap value
// (new Intl.NumberFormat(), new Map()) is not reported, and neither is a
// guard with any other condition, such as an age (that is a cache, refreshed
// on purpose).
// With no request handler found, nothing is reported.
//
// The fix is guided: build the value when the module loads (a top-level
// await), so the service listens only once it is ready.

import { ts, build, position, relOf } from '../lib/program.js';
import { unwrap, declOf, symbolAt, functionName } from '../lib/resolve.js';
import { readSources } from '../lib/sources.js';
import { perFile } from '../lib/isolate.js';
import { findHandlers } from '../lib/handlers.js';
import { finding, fingerprint } from '../core/finding.js';

export const CHECK = 'cold-start';
const MAX_DEPTH = 2;
const NOTE = 'Build the value when the module loads, with a top-level await (const x = await build();), and drop the check in the handler. An ES module that imports this one, the one that calls listen(), then starts listening only once the value is ready; behind a readiness probe, report ready only after it is built (STB-10).';

export function run(root, { handlers: brief = [] } = {}) {
  const { files, gaps } = readSources(root);
  const cx = { ...build(files), files };
  const rels = [...files.keys()].sort();
  const H = findHandlers(cx, rels, gaps, brief);
  const stats = { files: files.size, handlers: H.handlers.length, lazy: 0, skipped: { cheap: 0, otherCondition: 0, perRequest: 0, outsideRequests: 0, noHandlers: 0 }, notes: [...H.notes] };
  const findings = [];

  const lineOf = (n) => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const endLineOf = (n) => n.getSourceFile().getLineAndCharacterOfPosition(n.end).line + 1;
  const fileOf = (n) => relOf(n.getSourceFile().fileName);
  const within = (n, outer) => !!outer && n.getStart() >= outer.getStart() && n.end <= outer.end;
  const fnOf = (n) => { for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p; return null; };
  const statementOf = (n) => { let s = n; while (s.parent && !ts.isBlock(s.parent) && !ts.isSourceFile(s.parent) && !ts.isCaseClause(s.parent)) s = s.parent; return s; };
  function locationOf(node) {
    const p = position(node);
    const symbol = symbolAt(node);
    return { file: fileOf(node), line: p.line, column: p.column, ...(symbol ? { symbol } : {}) };
  }

  // Whether an expression does work that takes time: an await, a *Sync
  // call, a loop, or a call to a project function that does.
  function slow(e, depth = 0, seen = new Set()) {
    let found = false;
    const visit = (n) => {
      if (found) return;
      if (ts.isAwaitExpression(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) { found = true; return; }
      if (ts.isCallExpression(n)) {
        const c = unwrap(n.expression);
        const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : '';
        if (/Sync$/.test(name) || ['map', 'forEach', 'reduce', 'filter', 'flatMap'].includes(name)) { found = true; return; }
        if (depth < MAX_DEPTH) {
          const id = ts.isIdentifier(c) ? c : ts.isPropertyAccessExpression(c) ? c.name : null;
          let d = id && declOf(cx, id)?.decl;
          if (d && ts.isVariableDeclaration(d) && d.initializer) d = unwrap(d.initializer);
          if (d && ts.isFunctionLike(d) && d.body && relOf(d.getSourceFile().fileName) !== null && !seen.has(d)) {
            seen.add(d);
            if (slow(d.body, depth + 1, seen)) { found = true; return; }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(e);
    return found;
  }

  // Whether a condition tests only that a variable is unset.
  function unsetTest(cond, decl) {
    cond = unwrap(cond);
    const isIt = (e) => { e = unwrap(e); return !!e && ts.isIdentifier(e) && declOf(cx, e)?.decl === decl; };
    const isNothing = (e) => { e = unwrap(e); return !!e && (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')); };
    if (ts.isPrefixUnaryExpression(cond) && cond.operator === ts.SyntaxKind.ExclamationToken) return isIt(cond.operand);
    if (ts.isBinaryExpression(cond) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(cond.operatorToken.kind)) {
      if ((isIt(cond.left) && isNothing(cond.right)) || (isIt(cond.right) && isNothing(cond.left))) return true;
      const t = (a, b) => ts.isTypeOfExpression(unwrap(a)) && isIt(unwrap(a).expression) && ts.isStringLiteralLike(unwrap(b)) && unwrap(b).text === 'undefined';
      return t(cond.left, cond.right) || t(cond.right, cond.left);
    }
    return false;
  }

  for (const rel of rels) {
    perFile(gaps, rel, () => {
      const visit = (n) => {
        if (ts.isBinaryExpression(n) && ts.isIdentifier(unwrap(n.left))) consider(n);
        ts.forEachChild(n, visit);
      };
      visit(cx.sourceFile(rel));
    });
  }

  function consider(n) {
    const op = n.operatorToken.kind;
    const compound = op === ts.SyntaxKind.QuestionQuestionEqualsToken || op === ts.SyntaxKind.BarBarEqualsToken;
    if (!compound && op !== ts.SyntaxKind.EqualsToken) return;
    const id = unwrap(n.left);
    const decl = declOf(cx, id)?.decl;
    if (!decl || !ts.isVariableDeclaration(decl)) return;
    const fn = fnOf(n);
    if (!fn) return;
    // The guard: the compound operator itself, or an if whose condition is
    // the unset test and whose then-branch holds the assignment.
    let guard = null;
    if (compound) guard = statementOf(n);
    else {
      for (let p = n.parent; p && p !== fn; p = p.parent) {
        if (ts.isIfStatement(p) && within(n, p.thenStatement)) {
          if (unsetTest(p.expression, decl)) guard = p;
          else if (mentionsDecl(p.expression, decl)) { stats.skipped.otherCondition++; return; }
          break;
        }
      }
      if (!guard) return;
    }
    if (!slow(n.right)) { stats.skipped.cheap++; return; }
    stats.lazy++;
    // The variable outlives the request: declared outside the function that
    // assigns it, at module level or in a function no handler runs.
    const outer = fnOf(decl);
    if (within(decl, fn) || (outer && H.reach(decl).length)) { stats.skipped.perRequest++; return; }
    if (!H.handlers.length) { stats.skipped.noHandlers++; return; }
    const reach = H.reach(n);
    if (!reach.length) { stats.skipped.outsideRequests++; return; }
    const name = id.text;
    const labels = [...new Set(reach.map((h) => h.label))];
    const endpoints = [...new Map(reach.filter((h) => h.endpoint).map((h) => [h.label, h.endpoint])).values()];
    // Assigned only once an await in the value finishes: requests that
    // arrive in the meantime still see it unset.
    let awaited = false;
    const seek = (x) => { if (awaited || ts.isFunctionLike(x)) return; if (ts.isAwaitExpression(x)) awaited = true; else ts.forEachChild(x, seek); };
    seek(n.right);
    const shape = compound ? `${name} ${n.operatorToken.getText()} …` : `if (${guard.expression.getText()}) ${name} = …`;
    const where = functionName(fn);
    const declSt = statementOf(decl);
    const lines = new Set([lineOf(declSt)]);
    for (let i = lineOf(guard); i <= endLineOf(guard); i++) lines.add(i);
    findings.push({
      keyParts: [`${fileOf(decl)}#${name}`, 'lazy'],
      locations: [locationOf(n), locationOf(decl.name)], endpoints,
      message: `${name} is built by the first request that needs it${where ? `, in ${where}` : ''} (${shape}), on requests to ${labels.join(' and ')}. After every deploy or restart that request waits for the whole build${awaited ? ', and each request that arrives before it finishes starts the build again, since the value is assigned only when its build is done' : ''}. Built when the process starts, before the service listens, no request waits for it (STB-10).`,
      fix: { kind: 'guided', locations: [...lines].sort((a, b) => a - b).map((line) => ({ file: fileOf(n), line })), note: NOTE },
    });
  }

  function mentionsDecl(e, decl) {
    let m = false;
    const v = (x) => { if (m) return; if (ts.isIdentifier(x) && declOf(cx, x)?.decl === decl) m = true; else ts.forEachChild(x, v); };
    v(e);
    return m;
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
      rules: ['STB-10'],
      where: { locations: f.locations, ...(f.endpoints.length ? { endpoints: f.endpoints } : {}) },
      extension: { strength: 'SHOULD', fix: f.fix },
    });
  });
  if (!H.handlers.length && stats.skipped.noHandlers) stats.notes.push('No request handler was found, so values built on first use were not judged. Name entry points under handlers in erlang.config.json to judge them.');
  return { findings: out, run: stats };
}
