// no-cache (DAT-06; fixture L10): work whose answer is already known.
// Static: reads source, runs nothing.
//
// Reported, in code a request handler reaches:
//   - warning: a read inside a loop over a list (for-of, for-in, map,
//     forEach, flatMap) whose statement and arguments use nothing the loop
//     binds or assigns. It gets the same answer on every pass. Counter and
//     while loops, such as retries and pagination, are not judged.
//   - warning: the same read twice in one block, with the same statement and
//     the same arguments, and no write between them.
//   - info, unresolved: a whole-table aggregate (count, sum, avg, min, max,
//     GROUP BY, with no WHERE on a key) run by a GET handler with nothing in
//     front of it that could answer instead: no module-level value read
//     before the query, no cache library, and no Cache-Control or ETag on
//     the response. Whether such a result should be cached is a design
//     choice, so this is info; the trace and load forms judge it.
// Reads are pg statements and Prisma read methods (lib/db.js).
//
// Fixes are guided: move the read above the loop; reuse the first result;
// cache the aggregate for as long as its inputs allow.

import { ts, build, position, relOf } from '../lib/program.js';
import { unwrap, declOf, symbolAt, functionName } from '../lib/resolve.js';
import { readSources } from '../lib/sources.js';
import { perFile } from '../lib/isolate.js';
import { findHandlers } from '../lib/handlers.js';
import { databases } from '../lib/db.js';
import { finding, fingerprint } from '../core/finding.js';

export const CHECK = 'no-cache';
const ITERATORS = new Set(['map', 'forEach', 'flatMap']);
const CACHE_LIBS = new Set(['lru-cache', 'node-cache', 'memory-cache', 'cache-manager', 'keyv', 'quick-lru']);
const HOIST_NOTE = 'Make the read once, before the loop, and use its result inside: its statement and arguments do not change from one pass to the next (DAT-06).';
const REUSE_NOTE = 'Use the first result instead of reading again: nothing between the two reads changes what they read (DAT-06).';
const AGG_NOTE = 'If the inputs change rarely, cache the result for as long as they allow (an lru-cache entry with a ttl, or a module-level value with the time it was computed), and send Cache-Control (and an ETag) so clients and proxies can reuse it. Leave it uncached only if every request must see the latest data (DAT-06).';

export function run(root, { handlers: brief = [] } = {}) {
  const { files, gaps } = readSources(root);
  const cx = { ...build(files), files };
  const rels = [...files.keys()].sort();
  const H = findHandlers(cx, rels, gaps, brief);
  const db = databases(cx);
  const stats = { files: files.size, handlers: H.handlers.length, reads: 0, inLoops: 0, aggregates: 0, skipped: { dependsOnLoop: 0, outsideRequests: 0, writeBetween: 0, cached: 0, notGet: 0 }, notes: [...H.notes] };
  const findings = [];
  const unsure = H.handlers.length ? null : ' ERLANG found no request handler, so whether a request runs this is unknown (name entry points under handlers in erlang.config.json).';

  const lineOf = (n) => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const fileOf = (n) => relOf(n.getSourceFile().fileName);
  const statementOf = (n) => { let s = n; while (s.parent && !ts.isBlock(s.parent) && !ts.isSourceFile(s.parent) && !ts.isCaseClause(s.parent)) s = s.parent; return s; };
  const within = (n, outer) => !!outer && n.getStart() >= outer.getStart() && n.end <= outer.end;
  function locationOf(node) {
    const anchor = ts.isCallExpression(node) ? node.expression : node;
    const p = position(anchor);
    const symbol = symbolAt(node);
    return { file: fileOf(node), line: p.line, column: p.column, ...(symbol ? { symbol } : {}) };
  }
  const who = (node, reach) => {
    let named;
    for (let n = node.parent; n && !named; n = n.parent) if (ts.isFunctionLike(n)) named = functionName(n);
    return named ?? (reach?.length ? `The ${reach[0].label} handler` : 'Module code');
  };
  const endpointsOf = (reach) => [...new Map(reach.filter((h) => h.endpoint).map((h) => [h.label, h.endpoint])).values()];
  const textOf = (d) => d.node.arguments.map((a) => a.getText().replace(/\s+/g, ' ')).join(', ');

  // The innermost loop over a list around a node: { loop, body, bound } where
  // bound is every declaration the loop binds or makes in its body.
  function listLoopOf(node) {
    for (let n = node.parent; n; n = n.parent) {
      if (ts.isSourceFile(n)) return null;
      if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && within(node, n.statement)) return { loop: n, header: n, body: n.statement, bindings: n.initializer };
      if (ts.isFunctionLike(n) && ts.isCallExpression(n.parent) && n.parent.arguments[0] === n) {
        const c = unwrap(n.parent.expression);
        if (ts.isPropertyAccessExpression(c) && ITERATORS.has(c.name.text)) return { loop: n.parent, header: n.parent, body: n.body, bindings: n.parameters };
      }
    }
    return null;
  }
  // Declarations made by the loop: its bindings and every variable declared
  // or assigned inside its body.
  function loopDecls(l) {
    const out = new Set();
    const bindNames = (x) => {
      if (!x) return;
      if (Array.isArray(x)) { for (const y of x) bindNames(y); return; }
      if (ts.isVariableDeclarationList(x)) { x.declarations.forEach((d) => bindNames(d.name)); return; }
      if (ts.isParameter(x)) { bindNames(x.name); return; }
      if (ts.isIdentifier(x)) { const d = declOf(cx, x)?.decl; out.add(d ?? x.text); return; }
      if (ts.isObjectBindingPattern(x) || ts.isArrayBindingPattern(x)) x.elements.forEach((e) => { if (!ts.isOmittedExpression(e)) bindNames(e.name); });
    };
    bindNames(l.bindings);
    const visit = (n) => {
      if (ts.isVariableDeclaration(n)) bindNames(n.name);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(unwrap(n.left))) {
        const d = declOf(cx, unwrap(n.left))?.decl; if (d) out.add(d);
      }
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && ts.isIdentifier(unwrap(n.operand))) { const d = declOf(cx, unwrap(n.operand))?.decl; if (d) out.add(d); }
      ts.forEachChild(n, visit);
    };
    if (l.body) visit(l.body);
    return out;
  }
  // Whether the read's arguments use anything the loop makes, or a call
  // whose answer may differ (Date.now(), a random number, a function).
  function dependsOn(d, decls) {
    let dep = false;
    const visit = (n) => {
      if (dep) return;
      if (ts.isIdentifier(n)) { const x = declOf(cx, n)?.decl; if ((x && decls.has(x)) || decls.has(n.text) && !x) dep = true; }
      if (ts.isCallExpression(n)) dep = true;
      if (ts.isAwaitExpression(n)) dep = true;
      ts.forEachChild(n, visit);
    };
    for (const a of d.node.arguments) visit(a);
    return dep;
  }

  // A whole-table aggregate: an aggregate over a table with no WHERE that
  // pins a key.
  const AGG = /\b(count|sum|avg|min|max)\s*\(|\bgroup\s+by\b/;
  function wholeTableAggregate(d) {
    if (d.db !== 'pg') return null;
    const raw = db.sqlText(d.node.arguments[0]);
    if (raw === null) return null;
    const low = raw.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!/^\(?\s*(select|with)\b/.test(low) || !AGG.test(low)) return null;
    const from = low.match(/\bfrom\s+"?(?:\w+"?\.)?"?(\w+)"?/);
    if (!from) return null;
    const where = low.match(/\bwhere\b([\s\S]*?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/);
    if (where && /(?:"?\w+"?\.)?"?\w+"?\s*=\s*(\$\d+|any\s*\()/.test(where[1])) return null;
    return { table: from[1] };
  }
  // Something in front of the read that could answer instead: in the
  // functions from the handler down to the read, before it, a value kept
  // between requests (declared outside those functions: a let or var, or a
  // collection read with get, has or peek), a cache library, or a
  // Cache-Control or ETag header.
  function cachedInFront(d, handlerFns) {
    const fns = [...handlerFns];
    for (let n = d.node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) { fns.push(n); break; }
    for (const fn of fns) {
      let found = false;
      const visit = (n) => {
        if (found) return;
        if (ts.isStringLiteralLike(n) && /^(cache-control|etag)$/i.test(n.text)) found = true;
        if (ts.isIdentifier(n) && n.getStart() < d.node.getStart()) {
          const r = declOf(cx, n);
          const decl = r?.decl;
          if (r?.import && CACHE_LIBS.has(r.import.module)) found = true;
          else if (decl && ts.isVariableDeclaration(decl) && !fns.some((f) => within(decl, f)) && !isDbValue(decl)) {
            const mutable = !(decl.parent.flags & ts.NodeFlags.Const);
            const p = n.parent;
            const lookedUp = ts.isPropertyAccessExpression(p) && p.expression === n && ['get', 'has', 'peek'].includes(p.name.text);
            if (mutable || lookedUp) found = true;
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(fn.body ?? fn);
      if (found) return true;
    }
    return false;
  }
  const isDbValue = (decl) => !!decl.initializer && (db.isPg(decl.initializer) || db.isPrisma(decl.initializer));

  const reads = [];
  for (const rel of rels) {
    perFile(gaps, rel, () => {
      const visit = (n) => {
        if (ts.isCallExpression(n)) { const d = db.dbCall(n); if (d && d.op === 'read') reads.push(d); }
        ts.forEachChild(n, visit);
      };
      visit(cx.sourceFile(rel));
    });
  }

  for (const d of reads) {
    stats.reads++;
    const reach = H.reach(d.node);
    if (H.handlers.length && !reach.length) { stats.skipped.outsideRequests++; continue; }
    const labels = [...new Set(reach.map((h) => h.label))];
    const key = `${fileOf(d.node)}#${symbolAt(d.node) ?? '<module>'}`;
    const call = d.callee.getText();

    // A read inside a loop over a list, the same on every pass.
    const l = listLoopOf(d.node);
    if (l) {
      stats.inLoops++;
      if (dependsOn(d, loopDecls(l))) stats.skipped.dependsOnLoop++;
      else {
        const header = statementOf(l.header);
        findings.push({ severity: 'warning', reach, keyParts: [key, 'loop-invariant'], node: d.node,
          message: `${who(d.node, reach)} sends ${call}(${textOf(d).slice(0, 80)}) inside a loop over ${loopList(l)}, but nothing in it changes from one pass to the next: every pass reads the same answer again${labels.length ? `, on each request to ${labels.join(' and ')}` : ''}. One read before the loop gives the same result (DAT-06).`,
          fix: { kind: 'guided', locations: [...new Set([lineOf(header), lineOf(statementOf(d.node))])].sort((a, b) => a - b).map((line) => ({ file: fileOf(d.node), line })), note: HOIST_NOTE } });
        continue;
      }
    }

    // A whole-table aggregate behind a GET with nothing in front of it.
    const agg = wholeTableAggregate(d);
    if (agg) {
      stats.aggregates++;
      const gets = reach.filter((h) => h.endpoint?.method === 'GET');
      if (reach.length && !gets.length) stats.skipped.notGet++;
      else if (cachedInFront(d, gets.map((h) => h.fn).filter(Boolean))) stats.skipped.cached++;
      else findings.push({ severity: 'info', unresolved: true, reach, keyParts: [key, 'uncached-aggregate'], node: d.node,
        message: `${who(d.node, reach)} runs an aggregate over the whole ${agg.table} table on every request${gets.length ? ` to ${[...new Set(gets.map((h) => h.label))].join(' and ')}` : ''}, with nothing in front of it to answer instead: no cached value, and no Cache-Control or ETag on the response. If its inputs change rarely, each request repeats work whose answer is already known (DAT-06). Whether to cache it is a design choice, so this is info; the trace and load forms measure it.`,
        fix: { kind: 'guided', locations: aggLines(d, gets[0]?.fn), note: AGG_NOTE } });
    }
  }

  // The same read twice in one block, with no write between.
  const byBlock = new Map();
  for (const d of reads) {
    const st = statementOf(d.node);
    const block = st.parent;
    if (!block || !(ts.isBlock(block) || ts.isSourceFile(block))) continue;
    if (!byBlock.has(block)) byBlock.set(block, []);
    byBlock.get(block).push({ d, st });
  }
  const writes = [];
  for (const rel of rels) {
    perFile(gaps, rel, () => {
      const visit = (n) => { if (ts.isCallExpression(n)) { const d = db.dbCall(n); if (d && d.op !== 'read') writes.push(n); } ts.forEachChild(n, visit); };
      visit(cx.sourceFile(rel));
    });
  }
  for (const [block, list] of byBlock) {
    const seen = new Map();
    for (const { d, st } of list) {
      const sig = `${d.callee.getText()}(${textOf(d)})`;
      const first = seen.get(sig);
      if (first && first.st !== st && !d.node.arguments.some((a) => { let c = false; const v = (n) => { if (ts.isCallExpression(n)) c = true; ts.forEachChild(n, v); }; v(a); return c; })) {
        const between = writes.some((w) => w.getSourceFile() === block.getSourceFile() && w.getStart() > first.d.node.end && w.getStart() < d.node.getStart());
        if (between) { stats.skipped.writeBetween++; continue; }
        const reach = H.reach(d.node);
        if (H.handlers.length && !reach.length) continue;
        findings.push({ severity: 'warning', reach, keyParts: [`${fileOf(d.node)}#${symbolAt(d.node) ?? '<module>'}`, 'repeated-read'], node: d.node,
          message: `${who(d.node, reach)} sends ${d.callee.getText()}(${textOf(d).slice(0, 80)}) a second time, with the same arguments, after the read at line ${lineOf(first.d.node)}, and nothing between them writes: the second read can only get the answer the first already has (DAT-06).`,
          fix: { kind: 'guided', locations: [{ file: fileOf(d.node), line: lineOf(st) }], note: REUSE_NOTE } });
      } else if (!first) seen.set(sig, { d, st });
    }
  }

  // Where an aggregate's cache goes: the line above the handler, for the
  // value kept between requests, and the handler's body, which consults it.
  function aggLines(d, fn) {
    if (!fn) for (let n = d.node.parent; n && !fn; n = n.parent) if (ts.isFunctionLike(n)) fn = n;
    if (!fn?.body || !ts.isBlock(fn.body) || !fn.body.statements.length) return [{ file: fileOf(d.node), line: lineOf(statementOf(d.node)) }];
    const sf = fn.getSourceFile();
    const lines = new Set();
    const above = lineOf(statementOf(fn)) - 1;
    if (above >= 1) lines.add(above);
    const list = fn.body.statements;
    const a = lineOf(list[0]), b = sf.getLineAndCharacterOfPosition(list.at(-1).end).line + 1;
    for (let i = a; i <= b; i++) lines.add(i);
    return [...lines].sort((x, y) => x - y).map((line) => ({ file: fileOf(d.node), line }));
  }

  function loopList(l) {
    const h = l.header;
    if (ts.isForOfStatement(h) || ts.isForInStatement(h)) return h.expression.getText();
    return unwrap(h.expression).expression.getText();
  }

  const counts = new Map();
  findings.sort((a, b) => (fileOf(a.node) < fileOf(b.node) ? -1 : fileOf(a.node) > fileOf(b.node) ? 1 : a.node.getStart() - b.node.getStart()));
  const out = findings.map((f) => {
    const fp = fingerprint(CHECK, ...f.keyParts);
    const n = (counts.get(fp) ?? 0) + 1;
    counts.set(fp, n);
    const info = unsure || f.severity === 'info';
    const endpoints = endpointsOf(f.reach);
    return finding({
      specialist: 'erlang',
      check: CHECK,
      severity: info ? 'info' : f.severity,
      fingerprint: n === 1 ? fp : `${fp}|${n}`,
      message: f.message + (unsure ?? ''),
      detection: ['static'],
      rules: ['DAT-06'],
      where: { locations: [locationOf(f.node)], ...(endpoints.length ? { endpoints } : {}) },
      extension: { strength: 'SHOULD', ...(info ? { unresolved: true } : {}), fix: f.fix },
    });
  });
  return { findings: out, run: stats };
}
