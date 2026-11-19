// memory-growth (STB-05; fixture L05): module-level collections that
// requests add to and nothing removes from, so memory grows with uptime.
// Static: reads source, runs nothing.
//
// A collection is a Map, a Set, an array, or an object literal used as a
// dictionary, declared at module level. It grows when code a request
// handler reaches adds to it: map.set(key, ...) or set.add(value) with a key
// or value that is not a literal, array.push(...) or unshift(...), or
// object[key] = ... with a computed key that is not a literal.
// It is bounded, and not reported, when anything anywhere removes from it
// (delete, clear, shift, pop, splice, a delete of a property, a length
// assignment) or assigns the variable again; WeakMap and WeakSet entries go
// with their keys, so they are not counted. Library caches (lru-cache and
// the like) are not collections here.
// With no request handler found, nothing is reported: in a script or a
// tool a collection filled at startup looks the same as one that grows, and
// a short-lived process does not accumulate. The run data counts what was
// passed over.
//
// Fixes: a Map, Set or array gets an auto fix, a bound right after the add
// that drops the oldest entry past 10,000 (a starting value). An object
// used as a dictionary gets a guided fix naming every line that uses it.

import { ts, build, position, relOf } from '../lib/program.js';
import { unwrap, declOf, origin, isGlobal, symbolAt } from '../lib/resolve.js';
import { readSources } from '../lib/sources.js';
import { perFile } from '../lib/isolate.js';
import { findHandlers } from '../lib/handlers.js';
import { finding, fingerprint } from '../core/finding.js';

export const CHECK = 'memory-growth';
const BOUND = '10_000';
const REMOVERS = new Set(['delete', 'clear', 'shift', 'pop', 'splice']);
const ADDERS = { map: new Set(['set']), set: new Set(['add']), array: new Set(['push', 'unshift']) };
const AUTO_NOTE = `The bound, ${BOUND} entries, is a starting value: size it from the memory one entry takes and what the process can spare. A cache usually also wants an age limit; lru-cache gives both (new LRUCache({ max, ttl })) (STB-05).`;
const GUIDED_NOTE = 'Bound the object: keep the entries in a Map or an lru-cache (new LRUCache({ max, ttl })) and remove them when they expire or the session ends, or keep them outside the process, in the database or Redis (STB-05).';

export function run(root, { handlers: brief = [] } = {}) {
  const { files, gaps } = readSources(root);
  const cx = { ...build(files), files };
  const rels = [...files.keys()].sort();
  const H = findHandlers(cx, rels, gaps, brief);
  const stats = { files: files.size, handlers: H.handlers.length, collections: 0, growing: 0, skipped: { bounded: 0, literalKeys: 0, outsideRequests: 0, weak: 0, noHandlers: 0 }, notes: [...H.notes] };
  const findings = [];

  // The kind of collection an initializer makes: map, set, array, object,
  // weak, or null.
  function kindOf(e) {
    e = unwrap(e);
    if (!e) return null;
    if (ts.isArrayLiteralExpression(e)) return 'array';
    if (ts.isObjectLiteralExpression(e)) return 'object';
    if (ts.isNewExpression(e)) {
      const o = origin(cx, e.expression);
      if (isGlobal(o, 'Map')) return 'map';
      if (isGlobal(o, 'Set')) return 'set';
      if (isGlobal(o, 'Array')) return 'array';
      if (isGlobal(o, 'WeakMap') || isGlobal(o, 'WeakSet')) return 'weak';
    }
    return null;
  }

  const isLiteral = (e) => { e = unwrap(e); return !!e && (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword); };
  const statementOf = (n) => { let s = n; while (s.parent && !ts.isBlock(s.parent) && !ts.isSourceFile(s.parent) && !ts.isCaseClause(s.parent)) s = s.parent; return s; };
  const lineOf = (n) => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;
  function locationOf(node) {
    const anchor = ts.isCallExpression(node) ? node.expression : node;
    const p = position(anchor);
    const symbol = symbolAt(node);
    return { file: relOf(node.getSourceFile().fileName), line: p.line, column: p.column, ...(symbol ? { symbol } : {}) };
  }

  // Module-level collections, by declaration.
  const collections = new Map();
  for (const rel of rels) {
    perFile(gaps, rel, () => {
      const sf = cx.sourceFile(rel);
      for (const st of sf.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const kind = kindOf(d.initializer);
          if (!kind) continue;
          stats.collections++;
          if (kind === 'weak') { stats.skipped.weak++; continue; }
          collections.set(d, { decl: d, statement: st, kind, adds: [], bounded: false, uses: [] });
        }
      }
    });
  }

  // Every use of each collection, in every file.
  for (const rel of rels) {
    perFile(gaps, rel, () => {
      const visit = (n) => {
        if (ts.isIdentifier(n)) {
          const d = declOf(cx, n)?.decl;
          const c = d && collections.get(d);
          if (c && n !== d.name) use(c, n);
        }
        ts.forEachChild(n, visit);
      };
      visit(cx.sourceFile(rel));
    });
  }

  function parentOf(n) { let p = n.parent; while (p && ts.isParenthesizedExpression(p)) p = p.parent; return p; }
  function use(c, id) {
    c.uses.push(id);
    const p = parentOf(id);
    // Assigned again: whatever it held is dropped.
    if (ts.isBinaryExpression(p) && p.left === id && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) { c.bounded = true; return; }
    if (ts.isPropertyAccessExpression(p) && p.expression === id) {
      const name = p.name.text;
      const call = parentOf(p);
      if (name === 'length' && ts.isBinaryExpression(call) && call.left === p) { c.bounded = true; return; }
      if (!ts.isCallExpression(call) || unwrap(call.expression) !== p) return;
      if (REMOVERS.has(name)) { c.bounded = true; return; }
      if (ADDERS[c.kind]?.has(name)) {
        if ((c.kind === 'map' || c.kind === 'set') && isLiteral(call.arguments[0])) { c.literal = true; return; }
        c.adds.push(call);
      }
      return;
    }
    if (ts.isElementAccessExpression(p) && p.expression === id) {
      const outer = parentOf(p);
      if (ts.isDeleteExpression(outer)) { c.bounded = true; return; }
      if (c.kind === 'object' && ts.isBinaryExpression(outer) && outer.left === p && outer.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (isLiteral(p.argumentExpression)) { c.literal = true; return; }
        c.adds.push(outer);
      }
    }
  }

  for (const c of collections.values()) {
    if (c.bounded) { stats.skipped.bounded++; continue; }
    if (!c.adds.length) { if (c.literal) stats.skipped.literalKeys++; continue; }
    if (!H.handlers.length) { stats.skipped.noHandlers++; continue; }
    const reached = c.adds.map((a) => ({ a, reach: H.reach(a) })).filter((x) => x.reach.length);
    if (!reached.length) { stats.skipped.outsideRequests++; continue; }
    stats.growing++;
    const { a: add, reach } = reached[0];
    const name = c.decl.name.text;
    const kindText = { map: 'Map', set: 'Set', array: 'array', object: 'object used as a dictionary' }[c.kind];
    const labels = [...new Set(reached.flatMap((x) => x.reach.map((h) => h.label)))];
    const endpoints = [...new Map(reached.flatMap((x) => x.reach).filter((h) => h.endpoint).map((h) => [h.label, h.endpoint])).values()];
    const how = ts.isCallExpression(add) ? `${unwrap(add.expression).getText()}(...)` : `${add.left.getText()} = ...`;
    const declLoc = locationOf(c.decl.name);
    const addLoc = locationOf(add);
    findings.push({
      keyParts: [`${declLoc.file}#${name}`, 'unbounded'],
      locations: [addLoc, declLoc], endpoints,
      message: `${name}, a module-level ${kindText} (${declLoc.file}:${declLoc.line}), is added to by ${how}${labels.length ? ` on each request to ${labels.join(' and ')}` : ''}, and nothing ever removes from it. It grows for as long as the process runs, by one entry per ${c.kind === 'array' ? 'request' : 'distinct key'}, until the process runs out of memory or is restarted (STB-05).`,
      fix: fixOf(c, add),
    });
  }

  function fixOf(c, add) {
    const name = c.decl.name.text;
    if (c.kind === 'object' || c.adds.some((a) => !ts.isCallExpression(a))) {
      const lines = [...new Set([lineOf(c.decl), ...c.uses.map(lineOf)])].sort((a, b) => a - b);
      return { kind: 'guided', locations: lines.map((line) => ({ file: relOf(c.decl.getSourceFile().fileName), line })), note: GUIDED_NOTE };
    }
    const st = statementOf(add);
    const sf = st.getSourceFile();
    const startLine = sf.getLineAndCharacterOfPosition(st.getStart()).line;
    const indent = /^[ \t]*/.exec(sf.text.slice(sf.getLineStarts()[startLine]))[0];
    // Drop the oldest: a Map deletes its first key, a Set its first value,
    // an array the end it did not add to.
    const text = c.kind === 'array'
      ? `if (${name}.length > ${BOUND}) ${name}.${unwrap(add.expression).name.text === 'unshift' ? 'pop' : 'shift'}();`
      : `if (${name}.size > ${BOUND}) ${name}.delete(${name}.${c.kind === 'map' ? 'keys' : 'values'}().next().value);`;
    const insertAt = sf.getLineAndCharacterOfPosition(st.end);
    return {
      kind: 'auto',
      edits: [{ file: relOf(sf.fileName), line: insertAt.line + 1, column: insertAt.character + 1, length: 0, replace: `\n${indent}${text}` }],
      note: AUTO_NOTE,
    };
  }

  const counts = new Map();
  const out = findings.map((f) => {
    const fp = fingerprint(CHECK, ...f.keyParts);
    const n = (counts.get(fp) ?? 0) + 1;
    counts.set(fp, n);
    return finding({
      specialist: 'erlang',
      check: CHECK,
      severity: 'warning',
      fingerprint: n === 1 ? fp : `${fp}|${n}`,
      message: f.message,
      detection: ['static'],
      rules: ['STB-05'],
      where: { locations: f.locations, ...(f.endpoints.length ? { endpoints: f.endpoints } : {}) },
      extension: { strength: 'SHOULD', fix: f.fix },
    });
  });
  if (!H.handlers.length && stats.skipped.noHandlers) stats.notes.push('No request handler was found, so growing collections were not judged. Name entry points under handlers in erlang.config.json to judge them.');
  return { findings: out, run: stats };
}
