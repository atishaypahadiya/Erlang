// oversized-payload (DAT-04, DAT-08, DAT-09; fixture L04): responses bigger
// than their caller needs, and pages that call their service once per item.
// Static: reads source and server configuration, runs nothing.
//
// Reported:
//   - DAT-04, warning: a pg statement that selects every column (`*` or
//     `t.*`) and can return many rows, in code a request handler reaches.
//     Not reported: a statement bounded by a key (equality on the primary
//     key or a unique column) or by LIMIT 1, a count, and a table the owner
//     names under smallTables.
//   - DAT-08, warning: an Express or Fastify app that serves request
//     handlers with no compression. Compression is found as the
//     `compression` middleware (Express), `@fastify/compress` registered
//     (Fastify), or a proxy configuration in the repository that compresses
//     (nginx `gzip on`, a Caddyfile `encode`). One finding per app.
//   - DAT-09, warning: a call to the service's own API (a URL that starts
//     with `/`) inside a loop over a list, with the loop's item in the URL:
//     a page that makes one call per item. Loops over a literal list of ten
//     or fewer, and `while` loops (pagination), are not reported. Page code
//     is judged wherever it is, since no request handler reaches it.
// With no request handler found, DAT-04 and DAT-08 are info.
//
// Fixes are guided: which columns the caller uses, which endpoint to batch
// behind, and whether a proxy compresses are judgements.

import { ts, build, position, relOf } from '../lib/program.js';
import { unwrap, origin, isLib, isGlobal, symbolAt, functionName, declOf } from '../lib/resolve.js';
import { readSources } from '../lib/sources.js';
import { perFile } from '../lib/isolate.js';
import { proxyFiles } from '../lib/proxies.js';
import { findHandlers } from '../lib/handlers.js';
import { databases, sqlFacts, splitTop } from '../lib/db.js';
import { finding, fingerprint } from '../core/finding.js';

export const CHECK = 'oversized-payload';
const FIXED_LIST = 10;
const CALL_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'request', 'fetch']);
const ITERATORS = new Set(['map', 'forEach', 'flatMap']);

const SELECT_NOTE = 'Select the columns the response and its callers use, not every column: a list multiplies each unused column by its rows (DAT-04).';
const COMPRESS_NOTE = {
  fastify: "Register @fastify/compress right after the app is made: import compress from '@fastify/compress'; app.register(compress). Leave it out only if a proxy in front of the app compresses, and then say so in that proxy's configuration (DAT-08).",
  express: "Use the compression middleware before the routes: import compression from 'compression'; app.use(compression()). Leave it out only if a proxy in front of the app compresses (DAT-08).",
};
const CHATTY_NOTE = 'Fetch what the page shows for every item in one call: give the service an endpoint that takes the list (GET /items/prices?ids=1,2,3, with a cap on the ids) and look the results up by key, rather than one call per item (DAT-09).';

export function run(root, { handlers: brief = [], smallTables = [] } = {}) {
  const { files, gaps } = readSources(root);
  const cx = { ...build(files), files };
  const rels = [...files.keys()].sort();
  const H = findHandlers(cx, rels, gaps, brief);
  const db = databases(cx);
  const sql = sqlFacts(root, gaps);
  const small = new Set(smallTables.map((t) => t.toLowerCase()));
  const stats = { files: files.size, handlers: H.handlers.length, selects: 0, apps: 0, pageLoops: 0, proxyCompresses: [], skipped: { boundedByKey: 0, smallTable: 0, outsideRequests: 0, fixedList: 0, compressed: 0 }, notes: [...H.notes] };
  const findings = [];
  const unsure = H.handlers.length ? null : ' ERLANG found no request handler, so whether a request runs this is unknown (name entry points under handlers in erlang.config.json).';

  function locationOf(node) {
    const anchor = ts.isCallExpression(node) ? node.expression : node;
    const p = position(anchor);
    const symbol = symbolAt(node);
    return { file: relOf(node.getSourceFile().fileName), line: p.line, column: p.column, ...(symbol ? { symbol } : {}) };
  }
  const lineOf = (node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const fileOf = (node) => relOf(node.getSourceFile().fileName);
  const who = (node, reach) => {
    let named;
    for (let n = node.parent; n && !named; n = n.parent) if (ts.isFunctionLike(n)) named = functionName(n);
    return named ?? (reach?.length ? `The ${reach[0].label} handler` : 'Module code');
  };
  const endpointsOf = (reach) => [...new Map(reach.filter((h) => h.endpoint).map((h) => [h.label, h.endpoint])).values()];
  const uniqueColumns = (table) => {
    const out = new Set(['id']);
    for (const [t, cols] of sql.unique) if (t === table) for (const c of cols) out.add(c);
    return out;
  };

  // ---- DAT-04: SELECT * that can return many rows.
  function selectStar(d) {
    const raw = db.sqlText(d.node.arguments[0]);
    if (raw === null) return null;
    const low = raw.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''").replace(/\s+/g, ' ').trim().toLowerCase();
    const list = low.match(/^\(?\s*select\s+(?:distinct\s+)?([\s\S]*?)\s+from\b/);
    if (!list || !splitTop(list[1]).some((c) => /^(\w+\.)?\*$/.test(c.trim()))) return null;
    stats.selects++;
    const from = low.match(/\bfrom\s+"?(?:\w+"?\.)?"?(\w+)"?/);
    const table = from?.[1] ?? null;
    if (table && small.has(table)) { stats.skipped.smallTable++; return null; }
    if (/\blimit\s+1\b/.test(low)) { stats.skipped.boundedByKey++; return null; }
    const where = low.match(/\bwhere\b([\s\S]*?)(?:\border\s+by\b|\bgroup\s+by\b|\blimit\b|\bfor\s+update\b|$)/);
    if (where && !/\bor\b/.test(where[1])) {
      for (const m of where[1].matchAll(/(?:"?\w+"?\.)?"?(\w+)"?\s*=\s*(\$\d+|''|\d+)/g)) {
        if (uniqueColumns(table).has(m[1])) { stats.skipped.boundedByKey++; return null; }
      }
    }
    return { table };
  }

  // ---- DAT-09: a call to the service's own API in a loop over a list.
  // The URL's text when it is a relative path: a string or template that
  // starts with '/'.
  function relativeUrl(a) {
    a = unwrap(a);
    if (!a) return null;
    if (ts.isStringLiteralLike(a)) return a.text.startsWith('/') ? a : null;
    if (ts.isTemplateExpression(a)) return a.head.text.startsWith('/') ? a : null;
    return null;
  }
  function isRequestCall(call) {
    if (!call.arguments.length || !relativeUrl(call.arguments[0])) return false;
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee)) return isGlobal(origin(cx, callee), 'fetch') || callee.text === 'fetch';
    return ts.isPropertyAccessExpression(callee) && CALL_METHODS.has(callee.name.text);
  }
  // The loop around a node that iterates over a list, and the names its
  // items are bound to: { loop, names, body } or null.
  function listLoopOf(node) {
    for (let n = node.parent; n; n = n.parent) {
      if (ts.isSourceFile(n)) return null;
      if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && within(node, n.statement)) {
        return { loop: n, names: bindingNames(n.initializer), list: n.expression };
      }
      if (ts.isFunctionLike(n) && ts.isCallExpression(n.parent) && n.parent.arguments[0] === n) {
        const c = unwrap(n.parent.expression);
        if (ts.isPropertyAccessExpression(c) && ITERATORS.has(c.name.text) && n.parameters.length) {
          return { loop: statementOf(n.parent), names: bindingNames(n.parameters[0].name), list: c.expression };
        }
      }
    }
    return null;
  }
  const within = (n, outer) => n.getStart() >= outer.getStart() && n.end <= outer.end;
  const statementOf = (n) => { let s = n; while (s.parent && !ts.isBlock(s.parent) && !ts.isSourceFile(s.parent)) s = s.parent; return s; };
  function bindingNames(b) {
    const out = new Set();
    const visit = (x) => {
      if (!x) return;
      if (ts.isIdentifier(x)) { out.add(x.text); return; }
      if (ts.isVariableDeclarationList(x)) { x.declarations.forEach((d) => visit(d.name)); return; }
      if (ts.isObjectBindingPattern(x) || ts.isArrayBindingPattern(x)) x.elements.forEach((e) => { if (!ts.isOmittedExpression(e)) visit(e.name); });
    };
    visit(b);
    return out;
  }
  const mentions = (node, names) => {
    let found = false;
    const visit = (n) => { if (found) return; if (ts.isIdentifier(n) && names.has(n.text)) found = true; else ts.forEachChild(n, visit); };
    visit(node);
    return found;
  };
  // A literal list of at most FIXED_LIST items: fixed, not growing.
  function fixedList(e) {
    e = unwrap(e);
    if (ts.isIdentifier(e)) {
      const d = declOf(cx, e)?.decl;
      if (d && ts.isVariableDeclaration(d) && d.initializer && ts.getCombinedNodeFlags(d.parent) & ts.NodeFlags.Const) e = unwrap(d.initializer);
    }
    return !!e && ts.isArrayLiteralExpression(e) && e.elements.length <= FIXED_LIST && !e.elements.some(ts.isSpreadElement);
  }
  // The lines the person changes: the loop, the variable it fills when that
  // is declared just before it, and the statements after it that read that
  // variable.
  function chattyLines(loop) {
    const lines = new Set();
    const span = (n) => { const sf = n.getSourceFile(); const a = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1; const b = sf.getLineAndCharacterOfPosition(n.end).line + 1; for (let i = a; i <= b; i++) lines.add(i); };
    span(loop);
    const block = loop.parent;
    if (block && (ts.isBlock(block) || ts.isSourceFile(block))) {
      const list = block.statements;
      const i = list.indexOf(loop);
      const filled = new Set();
      const visit = (n) => {
        if (ts.isCallExpression(n)) { const c = unwrap(n.expression); if (ts.isPropertyAccessExpression(c) && ['push', 'set', 'add'].includes(c.name.text) && ts.isIdentifier(unwrap(c.expression))) filled.add(unwrap(c.expression).text); }
        ts.forEachChild(n, visit);
      };
      visit(loop);
      const prev = list[i - 1];
      if (prev && ts.isVariableStatement(prev) && prev.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && filled.has(d.name.text))) span(prev);
      for (const s of list.slice(i + 1)) if (mentions(s, filled)) span(s);
    }
    return [...lines].sort((a, b) => a - b).map((line) => ({ file: fileOf(loop), line }));
  }

  // ---- DAT-08: an app with no compression.
  const apps = [];
  let compressed = false;
  for (const rel of rels) {
    perFile(gaps, rel, () => {
      const visit = (n) => {
        if (ts.isCallExpression(n)) {
          const o = origin(cx, n.expression);
          if (isLib(o, 'express')) apps.push({ node: n, framework: 'express' });
          else if (isLib(o, 'fastify') || (o.k === 'import' && o.module === 'fastify' && o.path.length === 1 && o.path[0] === 'fastify')) apps.push({ node: n, framework: 'fastify' });
          if (isLib(o, 'compression')) compressed = true;
          const c = unwrap(n.expression);
          if (ts.isPropertyAccessExpression(c) && c.name.text === 'register' && n.arguments[0]) {
            const p = origin(cx, n.arguments[0]);
            if (p.k === 'import' && ['@fastify/compress', 'fastify-compress'].includes(p.module)) compressed = true;
          }
          const d = db.dbCall(n);
          if (d?.db === 'pg' && d.op === 'read') {
            const star = selectStar(d);
            if (star) {
              const reach = H.reach(n);
              if (H.handlers.length && !reach.length) stats.skipped.outsideRequests++;
              else findings.push({ rule: 'DAT-04', kind: 'select-star', node: n, reach, keyParts: [`${fileOf(n)}#${symbolAt(n) ?? '<module>'}`, 'select-star'],
                message: `${who(n, reach)} selects every column${star.table ? ` of ${star.table}` : ''} (SELECT *) in a statement that can return many rows${reach.length ? `, for ${[...new Set(reach.map((h) => h.label))].join(' and ')}` : ''}. Each column the caller does not use is sent once per row, from the database and in the response (DAT-04).`,
                fix: { kind: 'guided', locations: [{ file: fileOf(n), line: lineOf(n) }], note: SELECT_NOTE } });
            }
          }
          if (isRequestCall(n)) {
            const loop = listLoopOf(n);
            if (loop && mentions(n.arguments[0], loop.names)) {
              stats.pageLoops++;
              if (fixedList(loop.list)) stats.skipped.fixedList++;
              else {
                const url = unwrap(n.arguments[0]);
                const path = ts.isTemplateExpression(url) ? url.head.text + url.templateSpans.map((s) => `\${...}${s.literal.text}`).join('') : url.text;
                findings.push({ rule: 'DAT-09', kind: 'chatty', node: n, reach: [], page: true, keyParts: [`${fileOf(n)}#${symbolAt(n) ?? '<module>'}`, 'chatty'],
                  message: `${who(n)} calls ${path} once for each item of ${unwrap(loop.list).getText()}: a page of n items makes n calls to the service, each a round trip, where one call could carry them all (DAT-09).`,
                  fix: { kind: 'guided', locations: chattyLines(loop.loop), note: CHATTY_NOTE } });
              }
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(cx.sourceFile(rel));
    });
  }

  // Proxies in the repository that compress.
  for (const { file, text } of proxyFiles(root, gaps)) if (/\bgzip\s+on\b/.test(text) || /^\s*encode\b/m.test(text)) stats.proxyCompresses.push(file);
  stats.apps = apps.length;
  if (compressed || stats.proxyCompresses.length) stats.skipped.compressed += apps.length;
  else if (H.handlers.length || apps.length) {
    for (const app of apps) {
      const n = app.node;
      const sf = n.getSourceFile();
      const stmt = statementOf(n);
      const imports = sf.statements.filter(ts.isImportDeclaration);
      const afterImports = imports.length ? sf.getLineAndCharacterOfPosition(imports.at(-1).end).line + 2 : 1;
      const afterApp = sf.getLineAndCharacterOfPosition(stmt.end).line + 2;
      findings.push({ rule: 'DAT-08', kind: 'uncompressed', node: n, reach: [], keyParts: [`${fileOf(n)}#${symbolAt(n) ?? '<module>'}`, 'uncompressed'],
        message: `The ${app.framework === 'fastify' ? 'Fastify' : 'Express'} app made here sends its responses uncompressed: no ${app.framework === 'fastify' ? '@fastify/compress' : 'compression middleware'} is registered, and no proxy configuration in the repository compresses. Compression can cut a text response by up to 70% (MDN), so every response is sent at its full size (DAT-08).`,
        fix: { kind: 'guided', locations: [...new Set([afterImports, lineOf(n), afterApp])].sort((a, b) => a - b).map((line) => ({ file: fileOf(n), line })), note: COMPRESS_NOTE[app.framework] } });
    }
  }

  const counts = new Map();
  const out = findings.map((f) => {
    const fp = fingerprint(CHECK, ...f.keyParts);
    const n = (counts.get(fp) ?? 0) + 1;
    counts.set(fp, n);
    const info = unsure && !f.page;
    const endpoints = endpointsOf(f.reach);
    return finding({
      specialist: 'erlang',
      check: CHECK,
      severity: info ? 'info' : 'warning',
      fingerprint: n === 1 ? fp : `${fp}|${n}`,
      message: f.message + (info ? unsure : ''),
      detection: ['static'],
      rules: [f.rule],
      where: { locations: [locationOf(f.node)], ...(endpoints.length ? { endpoints } : {}) },
      extension: { strength: 'SHOULD', payload: f.kind, ...(info ? { unresolved: true } : {}), fix: f.fix },
    });
  });
  return { findings: out, run: stats };
}
