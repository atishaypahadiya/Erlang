// Following a value back to where it comes from: a call index over the
// program, and how many items a list has as far as it can be traced (a query
// result, request input, a count written in the code, or unknown).

import { ts } from './program.js';
import { MAX_DEPTH, unwrap, declOf } from './resolve.js';
import { perFile } from './isolate.js';
import { functionOf } from './handlers.js';

// Array methods whose callback runs once per element.
export const PER_ELEMENT = new Set(['map', 'forEach', 'flatMap', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex']);
// Array methods whose result has as many elements as the receiver, or fewer.
export const SAME_LIST = new Set(['map', 'filter', 'flatMap', 'flat', 'slice', 'concat', 'sort', 'toSorted', 'reverse', 'toReversed', 'entries', 'values', 'keys', 'split', 'splice', 'toSpliced']);
export const RANK = { fixed: 0, unknown: 1, count: 2, request: 2, query: 3 };
// A list this short, written in the code, is fixed: three settings rows, two
// default roles. A literal bound above it (1,000 seed rows) is a count.
export const FIXED_MAX = 10;

export function short(n) { const t = n.getText().replace(/\s+/g, ' '); return t.length > 60 ? `${t.slice(0, 57)}...` : t; }

// Every call to a project function, by the function (callers), and every
// function passed by name to an array method (passes: items.map(productOf)).
// visit, if given, sees every node on the same walk.
export function indexCalls(cx, rels, gaps, visit = null) {
  const callers = new Map();
  const passes = new Map();
  for (const rel of rels) {
    perFile(gaps, rel, () => {
      const walk = (n) => {
        if (ts.isCallExpression(n)) {
          const fn = functionOf(cx, n.expression);
          if (fn) { if (!callers.has(fn)) callers.set(fn, []); callers.get(fn).push(n); }
          const callee = unwrap(n.expression);
          if (ts.isPropertyAccessExpression(callee) && PER_ELEMENT.has(callee.name.text)) {
            const a = unwrap(n.arguments[0]);
            const f = a && ts.isIdentifier(a) ? functionOf(cx, a) : null;
            if (f) { if (!passes.has(f)) passes.set(f, []); passes.get(f).push({ call: n, arg: a, method: callee.name.text }); }
          }
        }
        if (visit) visit(n);
        ts.forEachChild(n, walk);
      };
      walk(cx.sourceFile(rel));
    });
  }
  return { callers, passes };
}

// { sizeOf, most, callbackOf } for one program; H from lib/handlers.js,
// dbCall from lib/db.js.
export function tracer(cx, { H, callers, dbCall }) {
  function callbackOf(fn) {
    const call = fn.parent;
    if (!call || !ts.isCallExpression(call) || unwrap(call.arguments[0]) !== fn && unwrap(call.arguments[1]) !== fn) return null;
    const callee = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee)) return null;
    if (PER_ELEMENT.has(callee.name.text) && unwrap(call.arguments[0]) === fn) return { form: 'callback', fn, call, over: callee.expression, method: callee.name.text };
    if (callee.name.text === 'from' && ts.isIdentifier(callee.expression) && callee.expression.text === 'Array' && unwrap(call.arguments[1]) === fn) return { form: 'callback', fn, call, over: call.arguments[0], method: 'Array.from' };
    return null;
  }

  // How many items a list has, as far as it can be traced: { kind, node,
  // text } with kind fixed, unknown, request or query; node is the query a
  // list of rows comes from.
  function sizeOf(e, depth = 0) {
    e = unwrap(e);
    const unknown = { kind: 'unknown', text: e ? short(e) : '' };
    if (!e || depth > MAX_DEPTH) return unknown;
    if (ts.isAwaitExpression(e)) return sizeOf(e.expression, depth + 1);
    if (ts.isArrayLiteralExpression(e)) return most(e.elements.filter(ts.isSpreadElement).map((s) => sizeOf(s.expression, depth + 1)), e.elements.length > FIXED_MAX ? { kind: 'count', text: `${e.elements.length} items` } : { kind: 'fixed' });
    if (ts.isObjectLiteralExpression(e) || ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) || ts.isTemplateExpression(e)) return { kind: 'fixed' };
    if (ts.isConditionalExpression(e)) return most([sizeOf(e.whenTrue, depth + 1), sizeOf(e.whenFalse, depth + 1)]);
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind)) return most([sizeOf(e.left, depth + 1), sizeOf(e.right, depth + 1)]);
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const base = sizeOf(e.expression, depth + 1);
      return base.kind === 'fixed' ? unknown : { ...base, text: base.kind === 'request' ? short(e) : base.text };
    }
    if (ts.isCallExpression(e) || ts.isTaggedTemplateExpression(e)) {
      const d = dbCall(e);
      if (d) return d.op === 'read' ? { kind: 'query', node: e, text: d.text } : unknown;
      if (ts.isTaggedTemplateExpression(e)) return unknown;
      const callee = unwrap(e.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const recv = unwrap(callee.expression);
        if (ts.isIdentifier(recv) && ['Object', 'Array'].includes(recv.text) && declOf(cx, recv) === null) {
          if (callee.name.text === 'from' && e.arguments[0] && ts.isObjectLiteralExpression(unwrap(e.arguments[0]))) return { kind: 'fixed' };
          return e.arguments[0] ? sizeOf(e.arguments[0], depth + 1) : unknown;
        }
        if (SAME_LIST.has(callee.name.text)) return sizeOf(callee.expression, depth + 1);
        const base = sizeOf(callee.expression, depth + 1);
        if (base.kind === 'request') return { ...base, text: short(e) };
      }
      if (ts.isIdentifier(callee) && ['String', 'Number', 'Array'].includes(callee.text) && declOf(cx, callee) === null) return e.arguments[0] ? sizeOf(e.arguments[0], depth + 1) : unknown;
      const fn = functionOf(cx, callee);
      if (fn && fn.body) {
        if (!ts.isBlock(fn.body)) return sizeOf(fn.body, depth + 1);
        const rets = [];
        const visit = (n) => { if (n !== fn.body && ts.isFunctionLike(n)) return; if (ts.isReturnStatement(n) && n.expression) rets.push(sizeOf(n.expression, depth + 1)); ts.forEachChild(n, visit); };
        visit(fn.body);
        return rets.length ? most(rets) : unknown;
      }
      return unknown;
    }
    if (!ts.isIdentifier(e)) return unknown;
    const r = declOf(cx, e);
    if (!r || r.import || !r.decl) return unknown;
    let d = r.decl;
    while (d && (ts.isBindingElement(d) || ts.isObjectBindingPattern(d) || ts.isArrayBindingPattern(d))) d = d.parent;
    if (!d) return unknown;
    if (ts.isVariableDeclaration(d)) {
      const stmt = d.parent?.parent;
      if (stmt && (ts.isForOfStatement(stmt) || ts.isForInStatement(stmt)) && stmt.initializer === d.parent) return sizeOf(stmt.expression, depth + 1);
      return d.initializer ? sizeOf(d.initializer, depth + 1) : unknown;
    }
    if (ts.isParameter(d)) {
      if (H.requestParam(d)) return { kind: 'request', text: short(e) };
      const fn = d.parent;
      const cb = callbackOf(fn);
      if (cb && fn.parameters[0] === d) return sizeOf(cb.over, depth + 1);
      const i = fn.parameters.indexOf(d);
      const sites = callers.get(fn) ?? [];
      return sites.length ? most(sites.map((c) => (c.arguments[i] ? sizeOf(c.arguments[i], depth + 1) : { kind: 'fixed' }))) : unknown;
    }
    return unknown;
  }
  function most(list, empty = { kind: 'unknown' }) {
    if (!list.length) return empty;
    return list.reduce((a, b) => (RANK[b.kind] > RANK[a.kind] ? b : a));
  }

  return { sizeOf, most, callbackOf };
}
