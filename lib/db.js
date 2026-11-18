// Database calls, as the checks recognise them, and what a project's files
// say about its database: the Prisma version it resolves and the unique
// fields of its models.
//
//   Prisma  prisma.<model>.<method>(...), $queryRaw and $executeRaw, on a
//           new PrismaClient(...) (from @prisma/client or a generated
//           client), its $extends(...), or the client a $transaction
//           callback receives.
//   pg      .query(...) on a pg Pool or Client, or on what pool.connect()
//           gives. The statement's first word says read, write or
//           transaction control; one built at run time is unknown.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ts } from './program.js';
import { MAX_DEPTH, unwrap, declOf, origin, isLib, nameOf } from './resolve.js';
import { perFile, decode } from './isolate.js';
import { OUTPUT_DIRS } from './sources.js';
import { excluded } from './scope.js';

export const PRISMA_READ = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);
export const PRISMA_WRITE = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']);
export const PRISMA_RAW = { $queryRaw: 'read', $queryRawUnsafe: 'read', $executeRaw: 'write', $executeRawUnsafe: 'write' };
export const BATCHABLE = new Set(['findUnique', 'findUniqueOrThrow']);

// { dbCall, isPrisma, isPg, sqlText, sqlOp } over one program. dbCall(node)
// gives { db, method, model?, op, node, callee, text } for a database call,
// or null; op is read, write, tx or unknown.
export function databases(cx) {
  function dbCall(n) {
    const tagged = ts.isTaggedTemplateExpression(n);
    const callee = unwrap(tagged ? n.tag : n.expression);
    if (!ts.isPropertyAccessExpression(callee)) return null;
    const method = callee.name.text;
    if (PRISMA_RAW[method] && isPrisma(callee.expression)) return { db: 'prisma', method, op: PRISMA_RAW[method], node: n, callee, text: callee.getText() };
    if (tagged) return null;
    const model = unwrap(callee.expression);
    if ((PRISMA_READ.has(method) || PRISMA_WRITE.has(method)) && ts.isPropertyAccessExpression(model) && isPrisma(model.expression)) {
      return { db: 'prisma', method, model: model.name.text, op: PRISMA_READ.has(method) ? 'read' : 'write', node: n, callee, text: callee.getText() };
    }
    if (method === 'query' && isPg(callee.expression)) return { db: 'pg', method, op: sqlOp(n.arguments[0]), node: n, callee, text: callee.getText() };
    return null;
  }

  function isPrisma(e, depth = 0) {
    e = unwrap(e);
    if (!e || depth > MAX_DEPTH) return false;
    if (ts.isAwaitExpression(e)) return isPrisma(e.expression, depth + 1);
    if (ts.isNewExpression(e)) {
      const c = unwrap(e.expression);
      const o = origin(cx, c);
      return (ts.isIdentifier(c) && c.text === 'PrismaClient') || (o.k === 'import' && o.path.at(-1) === 'PrismaClient') || (o.k === 'member' && o.name === 'PrismaClient');
    }
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind)) return isPrisma(e.left, depth + 1) || isPrisma(e.right, depth + 1);
    if (ts.isCallExpression(e)) { const c = unwrap(e.expression); return ts.isPropertyAccessExpression(c) && c.name.text === '$extends' && isPrisma(c.expression, depth + 1); }
    if (!ts.isIdentifier(e)) return false;
    const d = declOf(cx, e)?.decl;
    if (!d) return false;
    if (ts.isVariableDeclaration(d) && d.initializer) return isPrisma(d.initializer, depth + 1);
    if (ts.isParameter(d)) {
      if (d.type && /\b(PrismaClient|TransactionClient)\b/.test(d.type.getText())) return true;
      const fn = d.parent;
      const call = fn.parent;
      if (call && ts.isCallExpression(call) && call.arguments.some((a) => unwrap(a) === fn)) {
        const c = unwrap(call.expression);
        return ts.isPropertyAccessExpression(c) && c.name.text === '$transaction' && isPrisma(c.expression, depth + 1);
      }
    }
    return false;
  }

  function isPg(e, depth = 0) {
    e = unwrap(e);
    if (!e || depth > MAX_DEPTH) return false;
    if (ts.isAwaitExpression(e)) return isPg(e.expression, depth + 1);
    if (ts.isNewExpression(e)) {
      const o = origin(cx, e.expression);
      return isLib(o, 'pg', 'Pool') || isLib(o, 'pg', 'Client') || (o.k === 'import' && o.module === 'pg' && ['Pool', 'Client'].includes(o.path.join('.'))) || isLib(o, 'pg-pool');
    }
    if (ts.isCallExpression(e)) { const c = unwrap(e.expression); return ts.isPropertyAccessExpression(c) && c.name.text === 'connect' && isPg(c.expression, depth + 1); }
    if (!ts.isIdentifier(e)) return false;
    const d = declOf(cx, e)?.decl;
    if (d && ts.isVariableDeclaration(d) && d.initializer) return isPg(d.initializer, depth + 1);
    return !!(d && ts.isParameter(d) && d.type && /\b(Pool|PoolClient|Client)\b/.test(d.type.getText()));
  }

  // The statement a pg query sends, as far as its text can be read.
  function sqlText(a, depth = 0) {
    a = unwrap(a);
    if (!a || depth > 3) return null;
    if (ts.isStringLiteralLike(a)) return a.text;
    if (ts.isTemplateExpression(a)) return a.head.text;
    if (ts.isBinaryExpression(a) && a.operatorToken.kind === ts.SyntaxKind.PlusToken) return sqlText(a.left, depth + 1);
    if (ts.isObjectLiteralExpression(a)) {
      const t = a.properties.find((p) => ts.isPropertyAssignment(p) && nameOf(p.name) === 'text');
      return t ? sqlText(t.initializer, depth + 1) : null;
    }
    if (ts.isIdentifier(a)) {
      const d = declOf(cx, a)?.decl;
      if (d && ts.isVariableDeclaration(d) && d.initializer) return sqlText(d.initializer, depth + 1);
    }
    return null;
  }
  function sqlOp(a) {
    const t = sqlText(a);
    if (t === null) return 'unknown';
    const s = t.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').trim().replace(/^\(+\s*/, '').toLowerCase();
    const w = s.split(/\s+/)[0];
    if (['select', 'values', 'table', 'show', 'explain'].includes(w)) return 'read';
    if (['insert', 'update', 'delete', 'merge', 'copy'].includes(w)) return 'write';
    if (w === 'with') return /\b(insert|update|delete|merge)\b/.test(s) ? 'write' : 'read';
    if (['begin', 'commit', 'rollback', 'savepoint', 'release', 'start', 'set', 'end', 'abort'].includes(w)) return 'tx';
    return 'unknown';
  }

  return { dbCall, isPrisma, isPg, sqlText, sqlOp };
}

// The Prisma version a project resolves (lockfile first, then package.json's
// range), and the unique fields of each model in its schema. Batching is
// assumed, as in Prisma 6 and 7, when the version cannot be read.
export function prismaFacts(root, gaps) {
  const read = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs) || excluded(abs)) return null;
    let text = null;
    perFile(gaps, rel, () => { text = decode(readFileSync(abs)).replace(/^\uFEFF/, ''); });
    return text;
  };
  const json = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
  let version = null;
  let from = null;
  const lock = json(read('package-lock.json'));
  const locked = lock?.packages?.['node_modules/@prisma/client']?.version ?? lock?.dependencies?.['@prisma/client']?.version;
  if (locked) { version = locked; from = 'package-lock.json'; }
  if (!version) { const m = read('pnpm-lock.yaml')?.match(/@prisma\/client@(\d+\.\d+\.\d+[^\s:()'"]*)/); if (m) { version = m[1]; from = 'pnpm-lock.yaml'; } }
  if (!version) { const m = read('yarn.lock')?.match(/@prisma\/client@[^\n]*:\n\s+version:? "?(\d+\.\d+\.\d+[^"\n]*)/); if (m) { version = m[1]; from = 'yarn.lock'; } }
  if (!version) {
    const pkg = json(read('package.json'));
    const range = pkg?.dependencies?.['@prisma/client'] ?? pkg?.devDependencies?.['@prisma/client'];
    if (range) { version = range; from = 'package.json'; }
  }
  const major = version ? Number(version.match(/(\d+)/)?.[1]) : null;
  const unique = new Map();
  const models = new Map();
  const schemas = ['prisma/schema.prisma', 'schema.prisma'];
  const dir = join(root, 'prisma', 'schema');
  if (existsSync(dir) && !excluded(dir)) { try { for (const f of readdirSync(dir)) if (f.endsWith('.prisma')) schemas.push(`prisma/schema/${f}`); } catch { /* unreadable: no unique fields known */ } }
  for (const rel of schemas) {
    const text = read(rel);
    if (!text) continue;
    for (const m of text.matchAll(/^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) {
      const accessor = m[1][0].toLowerCase() + m[1].slice(1);
      models.set(accessor, m[1]);
      const set = unique.get(accessor) ?? new Set();
      for (const line of m[2].split('\n')) { const f = line.trim().match(/^(\w+)\s+\S+.*?@(id|unique)\b/); if (f) set.add(f[1]); }
      unique.set(accessor, set);
    }
  }
  return { version: version ?? 'unknown', from, batching: major === null || Number.isNaN(major) || major < 8, unique, models };
}

// Columns that identify at most one row, by table, from the SQL files in a
// project (migrations, schema dumps): primary keys, unique columns, single-
// column unique constraints and unique indexes. Table names are lower case.
export function sqlFacts(root, gaps) {
  const unique = new Map();
  const add = (table, col) => {
    const t = table.toLowerCase();
    if (!unique.has(t)) unique.set(t, new Set());
    unique.get(t).add(col.toLowerCase());
  };
  const name = String.raw`"?(\w+)"?`;
  const qualified = String.raw`(?:"?\w+"?\.)?` + name;
  const files = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink() || excluded(abs)) continue;
      if (e.isDirectory()) { if (!OUTPUT_DIRS.has(e.name)) walk(abs, r); continue; }
      if (e.isFile() && e.name.endsWith('.sql')) files.push([abs, r]);
    }
  };
  walk(root, '');
  for (const [abs, rel] of files.sort((a, b) => (a[1] < b[1] ? -1 : 1))) {
    perFile(gaps, rel, () => {
      const text = decode(readFileSync(abs)).replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of text.matchAll(new RegExp(String.raw`create\s+table\s+(?:if\s+not\s+exists\s+)?${qualified}\s*\(([\s\S]*?)\)\s*;`, 'gi'))) {
        const table = m[1];
        for (const part of splitTop(m[2])) {
          const p = part.trim();
          const constraint = p.match(new RegExp(String.raw`^(?:constraint\s+\S+\s+)?(?:primary\s+key|unique)\s*\(\s*${name}\s*\)$`, 'i'));
          if (constraint) { add(table, constraint[1]); continue; }
          const column = p.match(new RegExp(String.raw`^${name}\s+[\s\S]*\b(primary\s+key|unique)\b`, 'i'));
          if (column && !/^(constraint|primary|unique|foreign|check|exclude)$/i.test(column[1])) add(table, column[1]);
        }
      }
      for (const m of text.matchAll(new RegExp(String.raw`create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:"?\w+"?\s+)?on\s+(?:only\s+)?${qualified}\s*(?:using\s+\w+\s*)?\(\s*${name}\s*\)`, 'gi'))) add(m[1], m[2]);
      for (const m of text.matchAll(new RegExp(String.raw`alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?${qualified}\s+add\s+(?:constraint\s+\S+\s+)?(?:primary\s+key|unique)\s*\(\s*${name}\s*\)`, 'gi'))) add(m[1], m[2]);
    });
  }
  return { unique, files: files.length };
}

// A comma-separated list split at the top level, not inside parentheses.
export function splitTop(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}
