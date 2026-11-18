// n-plus-one (DAT-01, fixture L01a) and per-row-writes (DAT-02, fixture
// L01b): a database statement sent once per item of a list, in code a request
// handler reaches. Static: reads source, runs nothing. One pass finds both;
// reads go to n-plus-one, writes to per-row-writes.
//
// Database calls, found by where the client comes from:
//   Prisma  prisma.<model>.<method>(...), $queryRaw and $executeRaw, on a
//           new PrismaClient(...) (from @prisma/client or a generated
//           client), its $extends(...), or the client a $transaction
//           callback receives.
//   pg      .query(...) on a pg Pool or Client, or on what pool.connect()
//           gives. The statement's first word says read or write; one built
//           at run time gives info.
//
// Once per item: inside a for...of, for...in or for loop, or a callback of
// map, forEach, flatMap and the other array methods; directly, or through
// helpers that resolve to project code (MAX_CALLER_DEPTH calls deep). A
// while loop is not counted: it pages or drains, and its count is not the
// list's. The list must come from a query result or request input; a fixed
// list (an array literal, an object literal's keys, a numeric bound) is not
// reported, and one ERLANG cannot trace gives info.
//
// Prisma's batching, as observed for 7.10.1 (research/prisma-batching.md):
// findUnique and findUniqueOrThrow calls started together (not awaited one
// at a time) are sent as one query, so they are not reported. Awaits before
// the call that are themselves such reads keep them together; any other
// await before it gives info. findFirst, findMany, count, raw queries and
// every write are never batched. Prisma 8 drops the batching; the version
// is read from the lockfile or package.json.
//
// Request path: only code a handler reaches is reported (lib/handlers.js).
// When the project has no handler ERLANG can find, every finding is info.
//
// Static analysis sees the shape, not the size, and the messages say so.
// Every finding carries a fix: auto for the simple shapes (findFirst by a
// unique field to findUnique; a create, update or delete per item to
// createMany, updateMany or deleteMany), guided otherwise, listing the
// per-item call and the query the list comes from.

import { ts, build, position, relOf } from '../lib/program.js';
import { unwrap, nameOf, symbolAt } from '../lib/resolve.js';
import { readSources } from '../lib/sources.js';
import { perFile } from '../lib/isolate.js';
import { databases, prismaFacts, BATCHABLE } from '../lib/db.js';
import { indexCalls, tracer, short, FIXED_MAX } from '../lib/trace.js';
import { findHandlers } from '../lib/handlers.js';
import { finding, fingerprint } from '../core/finding.js';
import { replaceNode } from '../lib/fix.js';

export const CHECKS = ['n-plus-one', 'per-row-writes'];
const RULE = { 'n-plus-one': ['DAT-01'], 'per-row-writes': ['DAT-02'] };
const STRENGTH = { 'n-plus-one': 'MUST', 'per-row-writes': 'SHOULD' };
const SEVERITY = { 'n-plus-one': 'error', 'per-row-writes': 'warning' };
const MAX_CALLER_DEPTH = 3;

const NESTED_WRITES = new Set(['create', 'createMany', 'connect', 'connectOrCreate', 'upsert', 'update', 'updateMany', 'delete', 'deleteMany', 'set', 'disconnect']);

export function run(root, { handlers: brief = [] } = {}) {
  const { files, gaps } = readSources(root);
  const cx = { ...build(files), files };
  const rels = [...files.keys()].sort();
  const H = findHandlers(cx, rels, gaps, brief);
  const prisma = prismaFacts(root, gaps);
  const stats = {
    files: files.size,
    handlers: H.handlers.length,
    prisma: { version: prisma.version, from: prisma.from, batching: prisma.batching },
    calls: { prisma: 0, pg: 0 },
    perItem: 0,
    skipped: { batched: 0, fixedList: 0, outsideRequests: 0 },
    notes: H.notes,
  };
  const findings = [];
  const { dbCall, isPrisma } = databases(cx);
  const dbCalls = [];
  const { callers, passes } = indexCalls(cx, rels, gaps, (n) => {
    if (ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n)) {
      const d = dbCall(n);
      if (d) { dbCalls.push(d); stats.calls[d.db]++; }
    }
  });
  const { sizeOf, most, callbackOf } = tracer(cx, { H, callers, dbCall });

  // ---- Once per item ----

  // The per-item constructs around a node, innermost first, up to the first
  // function that is not a per-element callback.
  function constructs(node) {
    const out = [];
    for (let child = node, n = node.parent; n; child = n, n = n.parent) {
      if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && child === n.statement) out.push({ form: 'loop', loop: n, kind: ts.isForOfStatement(n) ? 'for...of' : 'for...in', over: n.expression, awaitLoop: !!n.awaitModifier });
      else if (ts.isForStatement(n) && child === n.statement) out.push({ form: 'loop', loop: n, kind: 'for', over: null });
      else if (ts.isFunctionLike(n)) {
        const cb = callbackOf(n);
        if (!cb) break;
        out.push(cb);
      }
    }
    return out;
  }
  const enclosingFunction = (node) => { for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n; return null; };

  // Where a database call runs once per item: [{ chain, cs }], chain from the
  // per-item call to the database call, cs the constructs around chain[0].
  function locate(node, chain, depth) {
    const cs = constructs(node);
    if (cs.length) return [{ chain, cs }];
    if (depth >= MAX_CALLER_DEPTH) return [];
    const fn = enclosingFunction(node);
    if (!fn) return [];
    const out = [];
    for (const c of callers.get(fn) ?? []) out.push(...locate(c, [c, ...chain], depth + 1));
    for (const p of passes.get(fn) ?? []) out.push({ chain: [p.arg, ...chain], cs: [{ form: 'callback', fn, call: p.call, over: unwrap(p.call.expression).expression, method: p.method, passed: true }, ...constructs(p.call)] });
    return out;
  }

  function forBound(loop) {
    const c = loop.condition && unwrap(loop.condition);
    if (!c || !ts.isBinaryExpression(c) || ![ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken].includes(c.operatorToken.kind)) return { kind: 'unknown', text: c ? short(c) : 'an unbounded for loop' };
    const bound = unwrap(c.right);
    if (ts.isNumericLiteral(bound)) { const n = Number(bound.text.replaceAll('_', '')); return n <= FIXED_MAX ? { kind: 'fixed' } : { kind: 'count', text: `${bound.text} iterations` }; }
    if (ts.isPropertyAccessExpression(bound) && bound.name.text === 'length') return sizeOf(bound.expression);
    const s = sizeOf(bound);
    return s.kind === 'fixed' ? s : { kind: s.kind === 'request' ? 'request' : 'unknown', text: short(bound) };
  }

  // Whether the per-item calls start together: 'together', 'sequential', or
  // 'uncertain' (an await before the call may start them at different times),
  // with the first such await.
  function timing(chain, cs) {
    let state = { how: 'together' };
    for (const c of cs) {
      if (c.form === 'loop') {
        if (c.awaitLoop || hasAwait(c.loop.statement)) return { how: 'sequential' };
        continue;
      }
      if (c.method.startsWith('reduce') && hasAwait(c.fn.body)) return { how: 'sequential' };
      const inner = chain.find((n) => within(n, c.fn));
      const before = inner ? awaitsBefore(inner, c.fn) : [];
      if (before.length && state.how === 'together') state = { how: 'uncertain', at: before[0] };
    }
    for (let i = 1; i < chain.length; i++) {
      const before = awaitsBefore(chain[i], enclosingFunction(chain[i]));
      if (before.length && state.how === 'together') state = { how: 'uncertain', at: before[0] };
    }
    return state;
  }
  const within = (node, fn) => { for (let n = node.parent; n; n = n.parent) if (n === fn) return true; return false; };
  function hasAwait(body) {
    let found = false;
    const visit = (n) => { if (found || ts.isFunctionLike(n)) return; if (ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier)) found = true; ts.forEachChild(n, visit); };
    visit(body);
    return found;
  }
  // Awaits in fn before node, other than awaits of reads Prisma batches.
  function awaitsBefore(node, fn) {
    const out = [];
    if (!fn?.body) return out;
    const visit = (n) => {
      if (ts.isFunctionLike(n)) return;
      if (ts.isAwaitExpression(n) && n.getEnd() <= node.getStart()) {
        const d = ts.isCallExpression(unwrap(n.expression)) ? dbCall(unwrap(n.expression)) : null;
        if (!(d && d.db === 'prisma' && BATCHABLE.has(d.method) && prisma.batching)) out.push(n);
      }
      ts.forEachChild(n, visit);
    };
    ts.isBlock(fn.body) ? fn.body.statements.forEach(visit) : visit(fn.body);
    return out;
  }

  // ---- Judging one database call reached once per item ----

  function judge(d, { chain, cs }) {
    let upto = -1;
    let size = { kind: 'fixed' };
    for (let i = 0; i < cs.length; i++) {
      const s = cs[i].form === 'loop' && !cs[i].over ? forBound(cs[i].loop) : sizeOf(cs[i].over);
      if (s.kind !== 'fixed') { upto = i; size = s; break; }
    }
    if (upto < 0) { stats.skipped.fixedList++; return; }
    const used = cs.slice(0, upto + 1);
    const site = chain[0];
    const reach = H.reach(site);
    if (H.handlers.length && !reach.length) { stats.skipped.outsideRequests++; return; }
    stats.perItem++;
    const check = d.op === 'write' ? 'per-row-writes' : 'n-plus-one';
    const t = timing(chain, used);
    const batchable = d.db === 'prisma' && BATCHABLE.has(d.method);
    if (batchable && prisma.batching && t.how === 'together') { stats.skipped.batched++; return; }

    const unsure = [];
    if (d.op === 'unknown') unsure.push(`the statement ${d.text} sends is built at run time, so whether it reads or writes is unknown`);
    if (batchable && prisma.batching && t.how === 'uncertain') unsure.push(`Prisma sends findUnique calls started together as one query, but the await at ${where(t.at)} may start them at different times`);
    if (size.kind === 'unknown') unsure.push(`what the ${describeConstruct(used.at(-1))} runs over (${size.text || 'its list'}) could not be traced to a query result or request input`);
    if (!H.handlers.length) unsure.push('ERLANG found no request handler, so whether a request runs this is unknown (name entry points under handlers in erlang.config.json)');

    const who = symbolAt(site) ?? (reach.length ? `The ${reach[0].label} handler` : 'Module code');
    const what = chain.length > 1 ? `${calleeName(site)}, which ${d.op === 'write' ? 'writes with' : 'runs'} ${d.text} (${where(d.node)}),` : d.text;
    const construct = used.at(-1);
    const sequential = t.how === 'sequential';
    const how = construct.form === 'loop' ? `${sequential ? 'is awaited' : 'runs'} once per item in a ${construct.kind} loop` : `runs once per item in a ${construct.method}() callback`;
    const over = size.kind === 'query' ? ` over the rows of ${size.text} (${where(size.node)})` : size.kind === 'request' ? ` over request input (${size.text})` : size.kind === 'count' ? ` over ${size.text}` : '';
    const endpoints = [...new Set(reach.map((h) => h.label))];
    const per = d.op === 'write' ? 'statement per row' : 'query per item';
    const so = endpoints.length ? `, so ${endpoints.join(' and ')} sends one ${per}` : `, one ${per}`;
    const why = d.db === 'pg' ? 'pg sends each statement on its own.'
      : d.op === 'write' ? 'Prisma sends every write on its own, even in Promise.all or a batch $transaction.'
        : batchable && !prisma.batching ? `Prisma ${prisma.version} does not batch findUnique.`
          : batchable ? 'Awaited one at a time, the calls cannot be batched.'
            : `Prisma batches only findUnique and findUniqueOrThrow started together; ${d.method ?? 'a raw query'} is never batched.`;
    const verb = d.op === 'write' ? 'writes' : 'reads';
    const message = unsure.length
      ? `${who} may ${verb === 'writes' ? 'write' : 'read'} once per item: ${what} ${how}${over}. Unknown: ${unsure.join('; ')}.`
      : `${who} ${verb} once per item: ${what} ${how}${over}${so}. ${why} The count grows with the list; static analysis sees the shape, not the size.`;

    const fix = fixFor(check, d, chain, used, size, t);
    const locations = chain.map(locationOf);
    const eps = [];
    for (const h of reach) if (h.endpoint && !eps.some((x) => x.method === h.endpoint.method && x.route === h.endpoint.route)) eps.push(h.endpoint);
    findings.push({
      check, severity: unsure.length ? 'info' : SEVERITY[check], message, fix, locations, endpoints: eps,
      keyParts: [key(locations[0]), d.db, d.model ? `${d.model}.${d.method}` : d.method, ...(chain.length > 1 ? [key(locations.at(-1))] : [])],
      extension: { strength: STRENGTH[check], client: d.db, over: { query: 'query result', request: 'request input', count: 'fixed count', unknown: 'unknown' }[size.kind], sequential, ...(unsure.length ? { unresolved: true } : {}) },
    });
  }

  const describeConstruct = (c) => (c.form === 'loop' ? `${c.kind} loop` : `${c.method}() callback`);

  // ---- Fixes ----

  function fixFor(check, d, chain, used, size, t) {
    const auto = chain.length === 1 && used.length === 1 ? autoFix(check, d, used[0], t) : null;
    if (auto) return auto;
    const nodes = [...chain, ...(size.kind === 'query' && size.node ? [size.node] : [])];
    let note;
    if (check === 'per-row-writes') {
      note = d.db === 'pg'
        ? 'Write the rows in one statement: INSERT ... SELECT * FROM unnest($1::type[], $2::type[]) or a multi-row VALUES list; for a change that differs per row, UPDATE ... FROM unnest(...) AS v(...) WHERE ... = v.key.'
        : 'Write the rows in one statement: createMany (createManyAndReturn for the rows back) for inserts, updateMany or deleteMany when every row gets the same change; for a change that differs per row, one UPDATE ... FROM unnest(...) through $executeRaw. A batch $transaction still sends one statement per row.';
    } else if (d.db === 'pg') {
      note = 'Read the related rows in one statement: a join in the query the list comes from, or one query with WHERE id = ANY($1) over the ids, matched back by id.';
    } else if (d.method === 'count') {
      note = 'Count with the list: include: { _count: { select: { <relation>: true } } } on the query the list comes from, or one groupBy over all the ids.';
    } else {
      note = `Load the related rows with the list: include or select on the query the list comes from, or one findMany with where: { <key>: { in: ids } }, matched back by id.${prisma.batching ? ' With Prisma 6 or 7, findUnique calls started together (Promise.all over map, not awaited one by one) are also sent as one query.' : ''}`;
    }
    return guided(nodes, note);
  }

  // The simple shapes, edited automatically:
  //   findFirst by one unique field, started together  -> findUnique
  //   for (const x of list) await m.create({ data })   -> one createMany
  //   await Promise.all(list.map((x) => m.create(...))) -> one createMany
  //   ... m.update({ where: { key: x }, data }) with data not using x
  //                                                    -> one updateMany
  //   ... m.delete({ where: { key: x } })              -> one deleteMany
  function autoFix(check, d, c, t) {
    if (d.db !== 'prisma' || !d.model) return null;
    const file = fileOf(d.node);
    const args = d.node.arguments;
    const obj = args.length === 1 && ts.isObjectLiteralExpression(unwrap(args[0])) ? unwrap(args[0]) : null;
    if (!obj) return null;
    const props = new Map();
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return null;
      props.set(nameOf(p.name), ts.isPropertyAssignment(p) ? p.initializer : p.name);
    }
    if (check === 'n-plus-one') {
      if (!['findFirst', 'findFirstOrThrow'].includes(d.method) || !prisma.batching || t.how !== 'together') return null;
      if ([...props.keys()].some((k) => !['where', 'select', 'include', 'omit'].includes(k))) return null;
      const where = unwrap(props.get('where'));
      if (!where || !ts.isObjectLiteralExpression(where) || where.properties.length !== 1) return null;
      const w = where.properties[0];
      const field = (ts.isPropertyAssignment(w) || ts.isShorthandPropertyAssignment(w)) ? nameOf(w.name) : null;
      if (!field || !prisma.unique.get(d.model)?.has(field)) return null;
      if (ts.isPropertyAssignment(w) && ts.isObjectLiteralExpression(unwrap(w.initializer))) return null;
      const to = d.method === 'findFirst' ? 'findUnique' : 'findUniqueOrThrow';
      return { kind: 'auto', edits: [replaceNode(file, d.callee.name, to)], note: `${field} is unique on ${d.model} (prisma/schema.prisma), so ${to} returns the same row, and Prisma 6 and 7 send ${to} calls started together as one query (research/prisma-batching.md). Prisma 8 drops that batching; then load the rows with one findMany.` };
    }
    if (!['create', 'update', 'delete'].includes(d.method)) return null;
    const base = d.callee.expression.getText();
    let item, overText, stmt;
    if (c.form === 'loop' && c.kind === 'for...of' && !c.awaitLoop) {
      const decls = ts.isVariableDeclarationList(c.loop.initializer) ? c.loop.initializer.declarations : [];
      if (decls.length !== 1 || !ts.isIdentifier(decls[0].name)) return null;
      item = decls[0].name;
      let body = c.loop.statement;
      if (ts.isBlock(body)) { if (body.statements.length !== 1) return null; body = body.statements[0]; }
      if (!ts.isExpressionStatement(body) || !ts.isAwaitExpression(body.expression) || unwrap(body.expression.expression) !== d.node) return null;
      overText = c.over.getText();
      stmt = c.loop;
    } else if (c.form === 'callback' && c.method === 'map' && !c.passed && ts.isArrowFunction(c.fn) && unwrap(c.fn.body) === d.node && c.fn.parameters.length === 1 && ts.isIdentifier(c.fn.parameters[0].name)) {
      item = c.fn.parameters[0].name;
      const outer = c.call.parent;
      if (!outer || !ts.isCallExpression(outer) || outer.arguments.length !== 1 || unwrap(outer.arguments[0]) !== c.call) return null;
      const oc = unwrap(outer.expression);
      const all = ts.isPropertyAccessExpression(oc) && ((ts.isIdentifier(oc.expression) && oc.expression.text === 'Promise' && oc.name.text === 'all') || (oc.name.text === '$transaction' && isPrisma(oc.expression)));
      if (!all || !outer.parent || !ts.isAwaitExpression(outer.parent) || !ts.isExpressionStatement(outer.parent.parent)) return null;
      overText = c.over.getText();
      stmt = outer.parent.parent;
    } else return null;
    const sym = cx.checker.getSymbolAtLocation(item);
    const symbolOf = (x) => (ts.isShorthandPropertyAssignment(x.parent) && x.parent.name === x ? cx.checker.getShorthandAssignmentValueSymbol(x.parent) : cx.checker.getSymbolAtLocation(x));
    const uses = (n) => { let found = false; const v = (x) => { if (found) return; if (ts.isIdentifier(x) && symbolOf(x) === sym) found = true; ts.forEachChild(x, v); }; if (n) v(n); return found; };
    const indentOf = (n) => { const sf = n.getSourceFile(); const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line; return sf.text.slice(sf.getPositionOfLineAndCharacter(line, 0), n.getStart(sf)); };
    if (!/^[ \t]*$/.test(indentOf(stmt))) return null;
    if (d.method === 'create') {
      if ([...props.keys()].join() !== 'data') return null;
      const data = unwrap(props.get('data'));
      if (hasNestedWrite(data)) return null;
      const dataText = ts.isObjectLiteralExpression(data) ? `(${props.get('data').getText()})` : props.get('data').getText();
      return { kind: 'auto', edits: [replaceNode(fileOf(stmt), stmt, `await ${base}.createMany({ data: ${overText}.map((${item.text}) => ${dataText}) });`)], note: 'createMany sends one INSERT for every row. It returns a count, not the rows (createManyAndReturn returns them), and it cannot nest writes to related models.' };
    }
    const allowed = d.method === 'update' ? 'where,data' : 'where';
    if ([...props.keys()].sort().join() !== allowed.split(',').sort().join()) return null;
    const where = unwrap(props.get('where'));
    if (!ts.isObjectLiteralExpression(where) || where.properties.length !== 1) return null;
    const w = where.properties[0];
    const value = ts.isShorthandPropertyAssignment(w) ? w.name : ts.isPropertyAssignment(w) ? unwrap(w.initializer) : null;
    if (!value || !ts.isIdentifier(value) || symbolOf(value) !== sym) return null;
    const keyName = nameOf(w.name);
    const data = props.get('data');
    if (data && (uses(data) || hasNestedWrite(unwrap(data)))) return null;
    const many = d.method === 'update' ? 'updateMany' : 'deleteMany';
    const text = `await ${base}.${many}({ where: { ${keyName}: { in: ${overText} } }${data ? `, data: ${data.getText()}` : ''} });`;
    return { kind: 'auto', edits: [replaceNode(fileOf(stmt), stmt, text)], note: `${many} sends one statement for every ${keyName}. Unlike ${d.method}, it does not fail when a ${keyName} matches no row, and it returns a count, not the rows.` };
  }
  function hasNestedWrite(e) {
    let found = false;
    const visit = (n) => { if (found) return; if (ts.isPropertyAssignment(n) && NESTED_WRITES.has(nameOf(n.name)) && n.parent !== e) found = true; ts.forEachChild(n, visit); };
    if (e && ts.isObjectLiteralExpression(e)) e.properties.forEach((p) => ts.isPropertyAssignment(p) && ts.forEachChild(p, visit));
    return found;
  }

  // ---- Findings ----

  function fileOf(node) { return relOf(node.getSourceFile().fileName); }
  function anchor(node) { return ts.isCallExpression(node) ? node.expression : ts.isTaggedTemplateExpression(node) ? node.tag : node; }
  function where(node) { return `${fileOf(node)}:${position(anchor(node)).line}`; }
  function locationOf(node) {
    const p = position(anchor(node));
    const symbol = symbolAt(node);
    return { file: fileOf(node), line: p.line, column: p.column, ...(symbol ? { symbol } : {}) };
  }
  function calleeName(node) { return ts.isCallExpression(node) ? short(node.expression) : short(node); }
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

  // Every database call, judged where it runs once per item.
  for (const d of dbCalls) {
    if (d.op === 'tx') continue;
    for (const hit of locate(d.node, [d.node], 0)) perFile(gaps, fileOf(d.node), () => judge(d, hit));
  }

  const counts = new Map();
  const out = findings.map((f) => {
    const base = fingerprint(f.check, ...f.keyParts);
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    return finding({
      specialist: 'erlang',
      check: f.check,
      severity: f.severity,
      fingerprint: n === 1 ? base : `${base}|${n}`,
      message: f.message,
      detection: ['static'],
      rules: RULE[f.check],
      where: { locations: f.locations, ...(f.endpoints.length ? { endpoints: f.endpoints } : {}) },
      extension: { ...f.extension, fix: f.fix },
    });
  });
  return { findings: out, run: stats, incomplete: gaps };
}
