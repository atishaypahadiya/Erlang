// unbounded-query (STB-04, fixture L02): a read whose result grows with the
// table, in code a request handler reaches. Static: reads source, runs
// nothing.
//
// Reported:
//   - a Prisma findMany with no take, and a SELECT (pg, or Prisma's
//     $queryRaw) with no LIMIT or FETCH FIRST;
//   - a take or LIMIT whose value comes from request input with no cap:
//     the client chooses the page size.
// Not reported (research/first-check.md, C):
//   - a read bounded by a key: equality on a primary key or unique column
//     (from the Prisma schema, the SQL files' DDL, or a column named id), or
//     a list of keys (in: ids, = any($1));
//   - aggregates: count, aggregate, groupBy, and a SELECT of only
//     count/sum/avg/min/max with no GROUP BY;
//   - reads streamed through a cursor (pg-cursor, pg-query-stream);
//   - tables the owner names under smallTables in erlang.config.json;
//   - a statement built at run time, whose text cannot be read (counted in
//     the run data).
// Severity: error when the rows go into the response (res.json, reply.send,
// a Fastify or Next.js handler's return value, through helpers that return
// them), warning when they are only used to compute something (reduce,
// length), since every row is still loaded. A page size from the client
// with no cap is an error. With no request handler found, every finding is
// info.
//
// Fixes: a page size from the client is capped automatically
// (Math.min(Math.max(Number(x) || 50, 1), 200)). An unbounded list is
// guided: paginate on the server, or aggregate in the database.

import { ts, build, position, relOf } from '../lib/program.js';
import { unwrap, declOf, nameOf, symbolAt, evalObject, lookup, isGlobal, origin } from '../lib/resolve.js';
import { readSources } from '../lib/sources.js';
import { perFile } from '../lib/isolate.js';
import { findHandlers, functionOf } from '../lib/handlers.js';
import { databases, prismaFacts, sqlFacts, splitTop } from '../lib/db.js';
import { indexCalls, tracer, short } from '../lib/trace.js';
import { finding, fingerprint } from '../core/finding.js';
import { replaceNode } from '../lib/fix.js';

export const CHECK = 'unbounded-query';
const RULES = ['STB-04'];
const STRENGTH = 'MUST';
const PAGE = 50;
const MAX_PAGE = 200;
const MAX_CALLER_DEPTH = 3;
const AUTO_NOTE = `${PAGE} rows by default and ${MAX_PAGE} at most are starting values (fixtures/PLAN.md, L02), not measured ones: set them from what the page shows.`;
// Uses of a list that keep its size out of the response.
const REDUCERS = new Set(['reduce', 'reduceRight', 'length', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'includes', 'indexOf', 'at', 'slice', 'size']);
const SINKS = new Set(['json', 'send', 'jsonp', 'end', 'write']);
const AGGREGATE = /^(count|sum|avg|min|max|bool_and|bool_or|every|coalesce\s*\(\s*(count|sum|avg|min|max))\s*\(/i;

export function run(root, { handlers: brief = [], smallTables = [] } = {}) {
  const { files, gaps } = readSources(root);
  const cx = { ...build(files), files };
  const rels = [...files.keys()].sort();
  const H = findHandlers(cx, rels, gaps, brief);
  const prisma = prismaFacts(root, gaps);
  const sql = sqlFacts(root, gaps);
  const small = new Set(smallTables.map((t) => t.toLowerCase()));
  const { dbCall } = databases(cx);
  const reads = [];
  const { callers } = indexCalls(cx, rels, gaps, (n) => {
    if (ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n)) {
      const d = dbCall(n);
      if (d && (d.op === 'read' || isStream(n))) reads.push(d);
    }
  });
  const { sizeOf } = tracer(cx, { H, callers, dbCall });
  const stats = {
    files: files.size,
    handlers: H.handlers.length,
    sqlFiles: sql.files,
    reads: reads.length,
    skipped: { boundedByKey: 0, limited: 0, aggregate: 0, streamed: 0, smallTable: 0, unreadable: 0, outsideRequests: 0 },
    notes: H.notes,
  };
  const findings = [];

  // ---- Judging one read ----

  function judge(d) {
    if (isStream(d.node)) { stats.skipped.streamed++; return; }
    const reach = H.reach(d.node);
    if (H.handlers.length && !reach.length) { stats.skipped.outsideRequests++; return; }
    const v = d.db === 'prisma' && d.model ? judgePrisma(d) : judgeSql(d);
    if (v.skip) { stats.skipped[v.skip]++; return; }
    const flow = rowsGo(d.node, 0, !!v.packed);
    const who = symbolAt(d.node) ?? (reach.length ? `The ${reach[0].label} handler` : 'Module code');
    const endpoints = [...new Set(reach.map((h) => h.label))];
    const at = endpoints.length ? ` of ${endpoints.join(' and ')}` : '';
    const unsure = H.handlers.length ? null : 'ERLANG found no request handler, so whether a request runs this is unknown (name entry points under handlers in erlang.config.json)';
    let severity, message, fix;
    if (v.client) {
      severity = 'error';
      message = `${who} lets the client choose how many rows it reads: ${v.what} is ${short(v.client)}, from request input (${v.source}), with no maximum, so a request${at} can read the whole table.`;
      const text = v.client.getText();
      const num = /^Number\(/.test(text) ? text : `Number(${text})`;
      fix = { kind: 'auto', edits: [replaceNode(fileOf(v.client), v.client, `Math.min(Math.max(${num} || ${PAGE}, 1), ${MAX_PAGE})`)], note: AUTO_NOTE };
    } else {
      severity = flow.sent ? 'error' : 'warning';
      const where = flow.sent ? `its rows go into the response${at}, which grows with the table` : `every row is loaded to compute ${endpoints.length ? `the response${at}` : 'a result'}, so time and memory grow with the table`;
      message = `${who} reads without a bound: ${d.text} has ${v.what}, and ${where}. Static analysis sees the shape, not the table's size; a table that stays small can be named under smallTables in erlang.config.json.`;
      const note = flow.sent
        ? `Page the list on the server: ${d.db === 'prisma' && d.model ? 'take' : 'LIMIT'} a default page of ${PAGE} with a maximum of ${MAX_PAGE} the client cannot raise, and a cursor for the next page (keyset: where id < the last id seen, ordered by id).`
        : `Compute it in the database instead of loading every row: ${d.db === 'prisma' && d.model ? 'aggregate with _sum, _count, _avg (or groupBy)' : 'SUM(), COUNT() or AVG() in the query'}, or page through the rows.`;
      fix = guided([d.node, ...flow.uses], note);
    }
    if (unsure) { severity = 'info'; message = `${message} Unknown: ${unsure}.`; }
    const locations = [locationOf(d.node)];
    const eps = [];
    for (const h of reach) if (h.endpoint && !eps.some((x) => x.method === h.endpoint.method && x.route === h.endpoint.route)) eps.push(h.endpoint);
    findings.push({
      severity, message, fix, locations, endpoints: eps,
      keyParts: [key(locations[0]), d.db, d.model ? `${d.model}.${d.method}` : d.method, v.client ? 'page-size' : 'no-limit'],
      extension: { strength: STRENGTH, client: d.db, rows: v.client ? 'client page size' : flow.sent ? 'sent' : 'loaded', ...(unsure ? { unresolved: true } : {}) },
    });
  }

  function judgePrisma(d) {
    if (d.method !== 'findMany') return { skip: 'aggregate' };
    const model = prisma.models.get(d.model) ?? d.model;
    if (small.has(d.model.toLowerCase()) || small.has(model.toLowerCase())) return { skip: 'smallTable' };
    const args = evalObject(cx, d.node.arguments[0]);
    const take = lookup(args, 'take');
    if (take.open) return { skip: 'unreadable' };
    if (!take.absent) {
      const page = pageSize(take.value);
      return page ? { client: take.value, what: 'take', source: page } : { skip: 'limited' };
    }
    const where = lookup(args, 'where');
    if (!where.absent && !where.open && keyed(where.value, prisma.unique.get(d.model))) return { skip: 'boundedByKey' };
    return { what: 'no take and no unique key in its where' };
  }
  // A Prisma where that names one row, or a list of rows by key.
  function keyed(e, uniqueFields) {
    const obj = evalObject(cx, e);
    for (const en of obj.entries) {
      if (en.open || !(uniqueFields?.has(en.key) || en.key === 'id')) continue;
      const val = unwrap(en.value);
      if (!val || !ts.isObjectLiteralExpression(val)) return true;
      const inner = evalObject(cx, val);
      if (inner.entries.some((x) => x.key === 'equals' || x.key === 'in')) return true;
    }
    return false;
  }

  function judgeSql(d) {
    const parts = sqlParts(d.db === 'pg' ? d.node.arguments[0] : d.node.template);
    if (!parts) return { skip: 'unreadable' };
    const text = parts.text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''").replace(/\s+/g, ' ').trim();
    const low = text.toLowerCase();
    if (!/^\(?\s*(select|with)\b/.test(low)) return { skip: 'aggregate' };
    const limit = low.match(/\blimit\s+(\$\d+|__hole\d+__|\d+|all)\b|\bfetch\s+(?:first|next)\s+(\$\d+|__hole\d+__|\d+)?/);
    if (limit && limit[1] !== 'all') {
      const ref = limit[1] ?? limit[2];
      const value = ref?.startsWith('$') ? paramValue(d, Number(ref.slice(1))) : ref?.startsWith('__hole') ? parts.holes[Number(ref.slice(6, -2))] : null;
      const page = value ? pageSize(value) : null;
      return page ? { client: value, what: `the LIMIT's value (${ref.startsWith('$') ? ref : 'interpolated'})`, source: page } : { skip: 'limited' };
    }
    const from = low.match(/\bfrom\s+"?(?:\w+"?\.)?"?(\w+)"?(?:\s+(?:as\s+)?(?!where|join|left|right|inner|outer|full|cross|order|group|limit|on|natural)(\w+))?/);
    if (!from) return { skip: 'aggregate' };
    const tables = new Map([[from[2] ?? from[1], from[1]], [from[1], from[1]]]);
    for (const j of low.matchAll(/\bjoin\s+"?(?:\w+"?\.)?"?(\w+)"?(?:\s+(?:as\s+)?(?!on|using)(\w+))?/g)) { tables.set(j[2] ?? j[1], j[1]); tables.set(j[1], j[1]); }
    if (small.has(from[1])) return { skip: 'smallTable' };
    const selectList = low.match(/^\(?\s*(?:with\b[\s\S]*?\)\s*)?select\s+(?:distinct\s+)?([\s\S]*?)\s+from\b/);
    if (selectList && !/\bgroup\s+by\b/.test(low) && splitTop(selectList[1]).every((c) => AGGREGATE.test(c.trim()))) return { skip: 'aggregate' };
    const where = low.match(/\bwhere\b([\s\S]*?)(?:\border\s+by\b|\bgroup\s+by\b|\bfor\s+update\b|$)/);
    if (where && !/\bor\b/.test(where[1])) {
      for (const m of where[1].matchAll(/(?:"?(\w+)"?\.)?"?(\w+)"?\s*=\s*(any\s*\(|\$\d+|__hole\d+__|''|\d+)/g)) {
        const table = m[1] ? tables.get(m[1]) : from[1];
        const uniq = uniqueColumns(table);
        if (uniq.has(m[2])) return { skip: 'boundedByKey' };
      }
    }
    // json_agg and array_agg pack every row into one: its first row is all of them.
    return { what: 'no LIMIT and no unique key in its WHERE', packed: /\b(json|jsonb|array)_agg\s*\(/.test(selectList?.[1] ?? '') };
  }
  function uniqueColumns(table) {
    const out = new Set(['id']);
    if (!table) return out;
    for (const [t, cols] of sql.unique) if (t === table) for (const c of cols) out.add(c);
    for (const [accessor, model] of prisma.models) if (model.toLowerCase() === table) for (const c of prisma.unique.get(accessor) ?? []) out.add(c.toLowerCase());
    return out;
  }
  // A statement's text with interpolations as __holeN__ markers.
  function sqlParts(a, depth = 0) {
    a = unwrap(a);
    if (!a || depth > 3) return null;
    if (ts.isStringLiteralLike(a)) return { text: a.text, holes: [] };
    if (ts.isTemplateExpression(a)) {
      const holes = a.templateSpans.map((s) => s.expression);
      return { text: a.head.text + a.templateSpans.map((s, i) => `__hole${i}__${s.literal.text}`).join(''), holes };
    }
    if (ts.isObjectLiteralExpression(a)) {
      const t = a.properties.find((p) => ts.isPropertyAssignment(p) && nameOf(p.name) === 'text');
      return t ? sqlParts(t.initializer, depth + 1) : null;
    }
    if (ts.isIdentifier(a)) {
      const d = declOf(cx, a)?.decl;
      if (d && ts.isVariableDeclaration(d) && d.initializer) return sqlParts(d.initializer, depth + 1);
    }
    return null;
  }
  // The value bound to $n: the nth element of the values array.
  function paramValue(d, n) {
    const values = unwrap(d.node.arguments?.[1]);
    if (values && ts.isArrayLiteralExpression(values)) return values.elements[n - 1] ?? null;
    const obj = unwrap(d.node.arguments?.[0]);
    if (obj && ts.isObjectLiteralExpression(obj)) {
      const p = obj.properties.find((x) => ts.isPropertyAssignment(x) && nameOf(x.name) === 'values');
      const arr = p && unwrap(p.initializer);
      if (arr && ts.isArrayLiteralExpression(arr)) return arr.elements[n - 1] ?? null;
    }
    return null;
  }
  function isStream(n) {
    if (!ts.isCallExpression(n)) return false;
    const a = unwrap(n.arguments[0]);
    if (!a || !ts.isNewExpression(a)) return false;
    const o = origin(cx, a.expression);
    return o.k === 'import' && ['pg-cursor', 'pg-query-stream'].includes(o.module);
  }

  // A page size from request input with no cap: the request text, or null.
  function pageSize(e) {
    if (capped(e, 0)) return null;
    const s = sizeOf(e);
    return s.kind === 'request' ? s.text : null;
  }
  function capped(e, depth) {
    e = unwrap(e);
    if (!e || depth > 4) return false;
    if (ts.isNumericLiteral(e)) return true;
    if (ts.isCallExpression(e)) {
      const callee = unwrap(e.expression);
      if (isGlobal(origin(cx, callee), 'Math', 'min')) return true;
      if (ts.isIdentifier(callee) && ['Number', 'parseInt', 'parseFloat'].includes(callee.text) && declOf(cx, callee) === null) return capped(e.arguments[0], depth + 1);
      const fn = functionOf(cx, callee);
      if (fn?.body) { let found = false; const v = (n) => { if (found) return; if (ts.isCallExpression(n) && isGlobal(origin(cx, unwrap(n.expression)), 'Math', 'min')) found = true; if (isComparison(n)) found = true; ts.forEachChild(n, v); }; v(fn.body); return found; }
      return false;
    }
    if (ts.isConditionalExpression(e)) return isComparison(unwrap(e.condition));
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) return capped(e.left, depth + 1);
    if (ts.isIdentifier(e)) {
      const d = declOf(cx, e)?.decl;
      if (d && ts.isVariableDeclaration(d) && d.initializer) return capped(d.initializer, depth + 1);
    }
    return false;
  }
  function isComparison(n) {
    return ts.isBinaryExpression(n) && [ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken].includes(n.operatorToken.kind)
      && (ts.isNumericLiteral(unwrap(n.left)) || ts.isNumericLiteral(unwrap(n.right)) || ts.isIdentifier(unwrap(n.right)));
  }

  // ---- Where the rows go ----

  // { sent, uses }: whether the rows of the value at node reach a response,
  // here or through functions that return them, and the lines that use them
  // in node's function (for a guided fix).
  function rowsGo(node, depth, packed = false) {
    const fn = enclosingFunction(node);
    const handler = fn ? H.handlers.find((h) => h.fn === fn) : null;
    const returnSends = !!handler && handler.framework !== 'express';
    const result = { sent: false, uses: [], returned: false };
    const follow = (start) => {
      let reduced = false;
      for (let child = start, n = start.parent; n && n !== fn; child = n, n = n.parent) {
        if (ts.isPropertyAccessExpression(n) && n.expression === child && REDUCERS.has(n.name.text)) reduced = true;
        if (ts.isElementAccessExpression(n) && n.expression === child && !packed) reduced = true;
        if (ts.isCallExpression(n) && n.arguments.includes(child)) {
          const callee = unwrap(n.expression);
          const sink = (ts.isPropertyAccessExpression(callee) && SINKS.has(callee.name.text)) || isGlobal(origin(cx, callee), 'Response', 'json') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'json' && ts.isIdentifier(callee.expression) && callee.expression.text === 'NextResponse');
          if (sink) { if (!reduced) result.sent = true; return; }
        }
        if (ts.isReturnStatement(n) || (ts.isArrowFunction(n) && n.body === child)) break;
        if (ts.isFunctionLike(n)) return;
        if (ts.isVariableDeclaration(n) && n.initializer === child) { bindings(n.name).forEach(useOf); return; }
      }
      // returned from fn
      if (reduced) return;
      if (returnSends) { result.sent = true; return; }
      result.returned = true;
    };
    const useOf = (id) => {
      const sym = cx.checker.getSymbolAtLocation(id);
      const visit = (n) => {
        if (ts.isIdentifier(n) && n !== id && cx.checker.getSymbolAtLocation(n) === sym) { result.uses.push(n); follow(n); }
        ts.forEachChild(n, visit);
      };
      if (fn?.body) visit(fn.body); else visit(node.getSourceFile());
    };
    follow(node);
    if (result.returned && !result.sent && fn && depth < MAX_CALLER_DEPTH) {
      for (const c of callers.get(fn) ?? []) if (rowsGo(c, depth + 1, packed).sent) { result.sent = true; break; }
    }
    return result;
  }
  // The identifiers a declaration binds: x, { rows }, { rows: orders }.
  function bindings(name) {
    if (ts.isIdentifier(name)) return [name];
    const out = [];
    for (const el of name.elements ?? []) if (!ts.isOmittedExpression(el)) out.push(...bindings(el.name));
    return out;
  }
  const enclosingFunction = (node) => { for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n; return null; };

  // ---- Findings ----

  function fileOf(node) { return relOf(node.getSourceFile().fileName); }
  function anchor(node) { return ts.isCallExpression(node) ? node.expression : ts.isTaggedTemplateExpression(node) ? node.tag : node; }
  function locationOf(node) {
    const p = position(anchor(node));
    const symbol = symbolAt(node);
    return { file: fileOf(node), line: p.line, column: p.column, ...(symbol ? { symbol } : {}) };
  }
  const key = (l) => `${l.file}#${l.symbol ?? '<module>'}`;
  function guided(nodes, note) {
    const seen = new Set();
    const locations = [];
    for (const n of nodes) {
      const l = locationOf(n);
      const k = `${l.file}:${l.line}`;
      if (!seen.has(k)) { seen.add(k); locations.push({ file: l.file, line: l.line }); }
    }
    return { kind: 'guided', locations, note };
  }

  for (const d of reads) perFile(gaps, fileOf(d.node), () => judge(d));

  const counts = new Map();
  const out = findings.map((f) => {
    const base = fingerprint(CHECK, ...f.keyParts);
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    return finding({
      specialist: 'erlang',
      check: CHECK,
      severity: f.severity,
      fingerprint: n === 1 ? base : `${base}|${n}`,
      message: f.message,
      detection: ['static'],
      rules: RULES,
      where: { locations: f.locations, ...(f.endpoints.length ? { endpoints: f.endpoints } : {}) },
      extension: { ...f.extension, fix: f.fix },
    });
  });
  return { findings: out, run: stats, incomplete: gaps };
}
