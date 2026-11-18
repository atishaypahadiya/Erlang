// missing-index (DAT-03, fixture L03): columns that queries filter, join or
// sort on, and foreign keys, with no index that starts with them. Static:
// reads source and schema files, runs nothing.
//
// The columns, from queries in code a request handler reaches:
//   SQL (pg, Prisma's $queryRaw): WHERE comparisons (=, <, >, <=, >=, IN,
//     BETWEEN, = ANY) joined by AND; the columns of JOIN ... ON equalities;
//     ORDER BY's first column when the query has a LIMIT and no filter.
//   Prisma: where fields (equality, equals, in, gt/gte/lt/lte; AND), and
//     orderBy's first field with take and no filter.
// The indexes, from lib/schema.js: primary keys, unique constraints and
// CREATE INDEX in the SQL files; @id, @unique, @@id, @@unique and @@index in
// schema.prisma. An index serves a column it starts with.
// A foreign key with no index starting with it is reported wherever it is
// used: PostgreSQL does not index foreign keys, so a delete or key update in
// the parent scans the child, and a join or include from parent to child
// reads all of it. (Prisma with MySQL indexes them itself.)
//
// Not reported: a filter with OR (the plan is not read); a filter on which
// one column is already indexed; a boolean or enum column, too unselective
// for an index to help; a table named under smallTables; a statement with a
// subquery, a CTE or a UNION, or built at run time (counted as unreadable).
//
// A warning (SHOULD): whether an index pays off depends on the table's size
// and the column's selectivity, which only a plan on realistic data shows
// (DAT-07; the trace harness). With no handler found, a query's finding is
// info; a foreign key's stays a warning.
//
// Fixes, auto: for SQL, a new migration beside the one that creates the
// table, numbered after the last (002_...sql); for Prisma, an @@index line
// in the model. Guided when migrations are not numbered files.

import { ts, build, position, relOf } from '../lib/program.js';
import { unwrap, evalObject, lookup, symbolAt } from '../lib/resolve.js';
import { readSources } from '../lib/sources.js';
import { perFile } from '../lib/isolate.js';
import { findHandlers } from '../lib/handlers.js';
import { databases } from '../lib/db.js';
import { readSchema, leads } from '../lib/schema.js';
import { finding, fingerprint } from '../core/finding.js';

export const CHECK = 'missing-index';
const RULES = ['DAT-03'];
const STRENGTH = 'SHOULD';
const WHERE_METHODS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy', 'updateMany', 'deleteMany', 'updateManyAndReturn']);
const RANGE = new Set(['equals', 'in', 'gt', 'gte', 'lt', 'lte']);
const END_OF_WHERE = /\b(order\s+by|group\s+by|limit|offset|for\s+update|for\s+share|returning|window|having)\b/;

export function run(root, { handlers: brief = [], smallTables = [] } = {}) {
  const { files, gaps } = readSources(root);
  const cx = { ...build(files), files };
  const rels = [...files.keys()].sort();
  const H = findHandlers(cx, rels, gaps, brief);
  const schema = readSchema(root, gaps);
  const small = new Set(smallTables.map((t) => t.toLowerCase()));
  const { dbCall } = databases(cx);
  const stats = { files: files.size, handlers: H.handlers.length, tables: schema.sql.size + schema.prisma.models.size, sqlFiles: schema.sqlFiles.length, queries: 0, skipped: { unreadable: 0, unknownTable: 0, smallTable: 0, outsideRequests: 0, indexed: 0 }, notes: H.notes };
  const groups = new Map();
  const isSmall = (t) => small.has(t.name.toLowerCase()) || (t.map && small.has(t.map.toLowerCase()));

  // ---- Queries ----

  for (const rel of rels) {
    perFile(gaps, rel, () => {
      const visit = (n) => {
        if (ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n)) { const d = dbCall(n); if (d) query(d); }
        ts.forEachChild(n, visit);
      };
      visit(cx.sourceFile(rel));
    });
  }

  function query(d) {
    const needs = d.db === 'prisma' && d.model ? prismaNeeds(d) : sqlNeeds(d);
    if (needs === null) { stats.skipped.unreadable++; return; }
    if (!needs.length) return;
    stats.queries++;
    const reach = H.reach(d.node);
    if (H.handlers.length && !reach.length) { stats.skipped.outsideRequests++; return; }
    for (const need of resolveJoins(needs)) {
      const t = need.table;
      if (isSmall(t)) { stats.skipped.smallTable++; continue; }
      if (leads(t, need.any)) { stats.skipped.indexed++; continue; }
      const col = need.suggest[0];
      const g = group(t, col);
      g.uses.push({ node: d.node, how: need.how, reach, suggest: need.suggest, db: d.db });
    }
  }
  function group(t, col) {
    const key = `${t.kind}:${t.name}.${col}`;
    if (!groups.has(key)) groups.set(key, { table: t, col, uses: [], fk: null });
    return groups.get(key);
  }

  // Prisma: { table, any, suggest, how } per model the call reads by.
  function prismaNeeds(d) {
    const t = schema.prisma.models.get(d.model);
    if (!t) { stats.skipped.unknownTable++; return []; }
    if (!WHERE_METHODS.has(d.method)) return [];
    const args = evalObject(cx, d.node.arguments[0]);
    if (args.entries.some((e) => e.open)) return null;
    const where = lookup(args, 'where');
    const filters = [];
    if (!where.absent) {
      const ok = whereFields(where.value, t, filters, 0);
      if (!ok) return [];
    }
    const take = !lookup(args, 'take').absent;
    const order = orderField(lookup(args, 'orderBy'), t);
    if (filters.length) return [{ table: t, any: filters, how: 'filter', suggest: order && take && !filters.includes(order) ? [filters[0], order] : [filters[0]] }];
    if (order && take) return [{ table: t, any: [order], how: 'order', suggest: [order] }];
    return [];
  }
  // Adds the indexable fields of a where to out; false when the where has
  // OR or NOT, or cannot be read.
  function whereFields(e, t, out, depth) {
    const obj = evalObject(cx, e);
    if (obj.entries.some((x) => x.open) || depth > 3) return false;
    for (const en of obj.entries) {
      if (en.key === 'OR' || en.key === 'NOT') return false;
      if (en.key === 'AND') {
        const v = unwrap(en.value);
        const items = v && ts.isArrayLiteralExpression(v) ? v.elements : [en.value];
        for (const it of items) if (!whereFields(it, t, out, depth + 1)) return false;
        continue;
      }
      const c = t.columns.get(en.key);
      if (!c || c.low) continue;
      const v = unwrap(en.value);
      if (v && ts.isObjectLiteralExpression(v)) {
        const inner = evalObject(cx, v);
        if (!inner.entries.some((x) => RANGE.has(x.key))) continue;
      }
      if (!out.includes(en.key)) out.push(en.key);
    }
    return true;
  }
  function orderField(o, t) {
    if (o.absent || o.open) return null;
    let v = unwrap(o.value);
    if (v && ts.isArrayLiteralExpression(v)) v = unwrap(v.elements[0]);
    const first = v ? evalObject(cx, v).entries[0] : null;
    return first?.key && t.columns.has(first.key) && !t.columns.get(first.key).low ? first.key : null;
  }

  // SQL: the statement's text, then its tables, filters, joins and sort.
  function sqlNeeds(d) {
    const raw = d.db === 'pg' ? textOf(d.node.arguments[0], 0) : textOf(d.node.template, 0);
    if (raw === null) return null;
    const s = raw.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''").replace(/\s+/g, ' ').trim().toLowerCase();
    if (!/^(select|update|delete)\b/.test(s)) return /^(insert|with|merge|copy|begin|commit|rollback|set)\b/.test(s) ? (s.startsWith('with') ? null : []) : null;
    if ((s.match(/\bselect\b/g) ?? []).length > 1 || /\bunion\b|\bintersect\b|\bexcept\b/.test(s)) return null;
    const tables = new Map();
    const stop = '(?!where\\b|join\\b|left\\b|right\\b|inner\\b|outer\\b|full\\b|cross\\b|order\\b|group\\b|limit\\b|on\\b|natural\\b|using\\b|for\\b|returning\\b|set\\b|offset\\b)';
    const lead = s.match(new RegExp(`^(?:update\\s+(?:only\\s+)?|(?:select\\b.*?|delete)\\s+from\\s+)"?(?:\\w+"?\\.)?"?(\\w+)"?(?:\\s+(?:as\\s+)?${stop}(\\w+))?`));
    if (!lead) return null;
    const driver = sqlTable(lead[1]);
    if (!driver) { stats.skipped.unknownTable++; return []; }
    tables.set(lead[2] ?? lead[1], driver); tables.set(lead[1], driver);
    const joins = [];
    for (const m of s.matchAll(new RegExp(`\\bjoin\\s+"?(?:\\w+"?\\.)?"?(\\w+)"?(?:\\s+(?:as\\s+)?${stop}(\\w+))?\\s+on\\s+`, 'g'))) {
      const t = sqlTable(m[1]);
      if (!t) continue;
      tables.set(m[2] ?? m[1], t); tables.set(m[1], t);
      const rest = s.slice(m.index + m[0].length);
      const end = rest.search(/\b(join|left|right|inner|full|cross|where|order|group|limit)\b/);
      joins.push(end < 0 ? rest : rest.slice(0, end));
    }
    const colOf = (q, c) => {
      if (q) { const t = tables.get(q); return t && t.columns.has(c) ? t : null; }
      if (driver.columns.has(c)) return driver;
      const hits = [...new Set(tables.values())].filter((t) => t.columns.has(c));
      return hits.length === 1 ? hits[0] : null;
    };
    const needs = [];
    const filters = new Map();
    const w = s.indexOf(' where ');
    let whereText = '';
    if (w >= 0) { whereText = s.slice(w + 7); const e = whereText.search(END_OF_WHERE); if (e >= 0) whereText = whereText.slice(0, e); }
    if (whereText && !/\bor\b/.test(whereText)) {
      for (const m of whereText.matchAll(/(?:"?(\w+)"?\.)?"?(\w+)"?\s*(?:<=|>=|=|<|>|\bin\s*\(|\bbetween\b)/g)) {
        if (m.index > 0 && /[\w(."$]/.test(whereText[m.index - 1])) continue;
        const t = colOf(m[1], m[2]);
        const c = t?.columns.get(m[2]);
        if (!t || c.low) continue;
        if (!filters.has(t)) filters.set(t, []);
        if (!filters.get(t).includes(m[2])) filters.get(t).push(m[2]);
      }
    }
    const limit = /\blimit\b|\bfetch\s+(first|next)\b/.test(s);
    const ob = s.match(/\border\s+by\s+(?:"?(\w+)"?\.)?"?(\w+)"?/);
    const orderT = ob ? colOf(ob[1], ob[2]) : null;
    for (const [t, cols] of filters) needs.push({ table: t, any: cols, how: 'filter', suggest: orderT === t && limit && !cols.includes(ob[2]) ? [cols[0], ob[2]] : [cols[0]] });
    if (!filters.size && !whereText && orderT && limit && !orderT.columns.get(ob[2]).low) needs.push({ table: orderT, any: [ob[2]], how: 'order', suggest: [ob[2]] });
    for (const on of joins) {
      for (const m of on.matchAll(/"?(\w+)"?\."?(\w+)"?\s*=\s*"?(\w+)"?\."?(\w+)"?/g)) {
        const a = colOf(m[1], m[2]), b = colOf(m[3], m[4]);
        if (a && b) needs.push({ how: 'join', pair: [[a, m[2]], [b, m[4]]], filters });
      }
    }
    return needs;
  }
  // A join needs an index on the side that is not indexed, when the other
  // side is (the usual foreign key to primary key) and the unindexed side's
  // table is not already narrowed by an indexed filter.
  function resolveJoins(needs) {
    const out = [];
    for (const n of needs) {
      if (n.how !== 'join') { out.push(n); continue; }
      const [[ta, ca], [tb, cb]] = n.pair;
      const ia = leads(ta, [ca]), ib = leads(tb, [cb]);
      if (ia === ib) continue;
      const [t, c] = ia ? [tb, cb] : [ta, ca];
      if (n.filters.has(t) && leads(t, n.filters.get(t))) continue;
      out.push({ table: t, any: [c], how: 'join', suggest: [c] });
    }
    return out;
  }
  function sqlTable(name) {
    const t = schema.sql.get(name.toLowerCase());
    if (t) return t;
    for (const m of schema.prisma.models.values()) if ((m.map ?? m.name).toLowerCase() === name.toLowerCase()) return null; // Prisma's columns are not read by column name
    return null;
  }
  // A statement's text, with interpolations as $0.
  function textOf(a, depth) {
    a = unwrap(a);
    if (!a || depth > 3) return null;
    if (ts.isStringLiteralLike(a)) return a.text;
    if (ts.isTemplateExpression(a)) return a.head.text + a.templateSpans.map((sp) => `$0${sp.literal.text}`).join('');
    if (ts.isObjectLiteralExpression(a)) { const t = lookup(evalObject(cx, a), 'text'); return t.value ? textOf(t.value, depth + 1) : null; }
    if (ts.isIdentifier(a)) { const d = cx.checker.getSymbolAtLocation(a)?.valueDeclaration; if (d && ts.isVariableDeclaration(d) && d.initializer && d.parent.flags & ts.NodeFlags.Const) return textOf(d.initializer, depth + 1); }
    return null;
  }

  // ---- Foreign keys ----

  const provider = schema.prisma.provider;
  const prismaFks = provider === 'mysql' || schema.prisma.relationMode === 'prisma' ? [] : [...schema.prisma.models.values()];
  for (const t of [...schema.sql.values(), ...prismaFks]) {
    if (isSmall(t)) continue;
    for (const fk of t.fks) {
      if (leads(t, [fk.cols[0]])) continue;
      group(t, fk.cols[0]).fk = fk;
    }
  }

  // ---- Findings ----

  const findings = [];
  const migrationNumbers = new Map();
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key);
    if (!g.uses.length && !g.fk) continue;
    const t = g.table;
    const uses = g.uses.sort((a, b) => (fileOf(a.node) + pad(position(a.node).line)).localeCompare(fileOf(b.node) + pad(position(b.node).line)));
    const unsure = !H.handlers.length && !g.fk;
    const locations = uses.map((u) => locationOf(u.node));
    if (g.fk) locations.push({ file: g.fk.file, line: g.fk.line, column: g.fk.column });
    const seen = new Set();
    const locs = locations.filter((l) => { const k = `${l.file}:${l.line}:${l.column}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const cols = (uses.find((u) => u.suggest.length > 1) ?? uses[0])?.suggest ?? [g.col];
    const tableName = t.kind === 'prisma' ? t.name : t.name;
    const declared = t.indexes.length ? `indexes start with ${[...new Set(t.indexes.map((i) => i.cols[0].replace(/^expr:/, '')))].join(', ')}` : 'it declares no index';
    const parts = [];
    const db = t.kind === 'prisma' && !['postgresql', 'cockroachdb'].includes(provider) ? 'the database' : 'PostgreSQL';
    if (uses.length) {
      const u = uses[0];
      const who = locs[0].symbol ?? (u.reach.length ? `The ${u.reach[0].label} handler` : 'Module code');
      const eps = [...new Set(uses.flatMap((x) => x.reach.map((h) => h.label)))];
      const verb = u.how === 'join' ? `joins to ${tableName} on ${g.col}` : u.how === 'order' ? `sorts all of ${tableName} by ${g.col} to return the first rows` : `filters ${tableName} on ${g.col}`;
      parts.push(`${who}${eps.length ? ` (${eps.join(', ')})` : ''} ${verb}${uses.length > 1 ? `, as do ${uses.length - 1} other quer${uses.length === 2 ? 'y' : 'ies'}` : ''}, and no index on ${tableName} starts with ${g.col} (${declared}): at production size each such query reads every row of ${tableName}.`);
      if (g.fk) parts.push(`${g.col} is also a foreign key to ${g.fk.ref}, which ${db} does not index on its own.`);
    } else {
      parts.push(`${tableName}.${g.col} is a foreign key to ${g.fk.ref} with no index starting with it (${declared}), and ${db} does not create one: each delete or key update in ${g.fk.ref} scans ${tableName}, and a join or include from ${g.fk.ref} reads all of ${tableName}.`);
    }
    parts.push('Static analysis sees no table sizes or plans (DAT-03, DAT-07): a table that stays small can be named under smallTables in erlang.config.json.');
    let message = parts.join(' ');
    if (unsure) message += ' Unknown: ERLANG found no request handler, so whether a request runs this is unknown (name entry points under handlers in erlang.config.json).';
    const eps = [];
    for (const u of uses) for (const h of u.reach) if (h.endpoint && !eps.some((x) => x.method === h.endpoint.method && x.route === h.endpoint.route)) eps.push(h.endpoint);
    findings.push({
      severity: unsure ? 'info' : 'warning', message, locations: locs, endpoints: eps,
      keyParts: [t.kind, t.name, g.col],
      extension: { strength: STRENGTH, client: t.kind === 'prisma' ? 'prisma' : 'pg', table: tableName, index: cols, ...(unsure ? { unresolved: true } : {}), fix: fixFor(t, cols) },
    });
  }

  function fixFor(t, cols) {
    if (t.kind === 'prisma') {
      return { kind: 'auto', edits: [{ file: t.file, line: t.closeLine, column: 1, length: 0, replace: `  @@index([${cols.join(', ')}])\n` }], note: `Run prisma migrate dev to write the migration. On a large table in production, edit it to CREATE INDEX CONCURRENTLY (outside a transaction), so writes are not blocked while the index builds.` };
    }
    const name = `${t.name}_${cols.join('_')}_idx`;
    const sqlText = `create index ${name} on ${t.name} (${cols.join(', ')});\n`;
    const dir = t.file.includes('/') ? t.file.slice(0, t.file.lastIndexOf('/')) : '';
    const numbered = schema.sqlFiles.filter((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '') === dir).map((f) => f.slice(dir ? dir.length + 1 : 0)).map((b) => b.match(/^(\d+)[_-]/)).filter(Boolean);
    if (!numbered.length) return { kind: 'guided', locations: [{ file: t.file, line: t.line }], note: `Add a migration: ${sqlText.trim()} On a large table in production, use CREATE INDEX CONCURRENTLY outside a transaction.` };
    const width = numbered[0][1].length;
    if (!migrationNumbers.has(dir)) migrationNumbers.set(dir, Math.max(...numbered.map((m) => Number(m[1]))));
    const n = migrationNumbers.get(dir) + 1;
    migrationNumbers.set(dir, n);
    const file = `${dir ? `${dir}/` : ''}${String(n).padStart(width, '0')}_${name}.sql`;
    return { kind: 'auto', edits: [{ file, line: 1, column: 1, length: 0, replace: sqlText }], note: `A new migration, ${file}. On a large table in production, use CREATE INDEX CONCURRENTLY, outside a transaction, so writes are not blocked while the index builds.` };
  }

  function pad(n) { return String(n).padStart(8, '0'); }
  function fileOf(node) { return relOf(node.getSourceFile().fileName); }
  function locationOf(node) {
    const anchorNode = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
    const p = position(anchorNode);
    const symbol = symbolAt(node);
    return { file: fileOf(node), line: p.line, column: p.column, ...(symbol ? { symbol } : {}) };
  }

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
      detection: ['static', 'config'],
      rules: RULES,
      where: { locations: f.locations, ...(f.endpoints.length ? { endpoints: f.endpoints } : {}) },
      extension: f.extension,
    });
  });
  return { findings: out, run: stats, incomplete: gaps };
}
