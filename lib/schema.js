// A project's tables as its schema files declare them: columns and their
// types, indexes (primary keys and unique constraints included) and foreign
// keys, with the file and line of each. Read from the SQL files in scope
// (migrations, schema dumps) and from schema.prisma. Static: reads files,
// runs nothing.
//
// SQL: CREATE TABLE (column PRIMARY KEY / UNIQUE / REFERENCES, table
// constraints), CREATE [UNIQUE] INDEX, ALTER TABLE ... ADD (constraints, a
// column with REFERENCES). An index on an expression (lower(email)) is kept
// as an expression, which no plain column matches. Tables are keyed lower
// case.
// Prisma: models with @id, @unique, @@id, @@unique, @@index, @map, @@map,
// and the scalar fields named in a relation's fields: [...] as a foreign
// key. Models are keyed by their client accessor (Event: event), in field
// names, not column names.
//
// Scanned with indexOf and anchored patterns only: schema files are input
// ERLANG does not control.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { OUTPUT_DIRS } from './sources.js';
import { excluded } from './scope.js';
import { perFile, decode } from './isolate.js';

const PRISMA_SCALARS = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes']);
const LOW_SELECTIVITY_SQL = /^(bool|boolean)$/;

// { sql: Map(table -> table), prisma: { models: Map(accessor -> table),
//   provider, files }, sqlFiles }
// table: { name, kind, file, line, columns: Map(col -> { type, line,
//   column, low }), indexes: [{ cols, unique, file, line }], fks: [{ cols,
//   ref, file, line, column }], closeLine? (Prisma), map? }
export function readSchema(root, gaps) {
  const sql = new Map();
  const sqlFiles = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink() || excluded(abs)) continue;
      if (e.isDirectory()) { if (!OUTPUT_DIRS.has(e.name) && !e.name.startsWith('.')) walk(abs, r); continue; }
      if (e.isFile() && e.name.endsWith('.sql')) sqlFiles.push([abs, r]);
    }
  };
  walk(root, '');
  sqlFiles.sort((a, b) => (a[1] < b[1] ? -1 : 1));
  // Prisma writes its own migrations from schema.prisma: read the schema,
  // not them, when there is one.
  const prismaSchemas = ['prisma/schema.prisma', 'schema.prisma'].filter((r) => existsSync(join(root, r)) && !excluded(join(root, r)));
  const dir = join(root, 'prisma', 'schema');
  if (existsSync(dir) && !excluded(dir)) { try { for (const f of readdirSync(dir).sort()) if (f.endsWith('.prisma')) prismaSchemas.push(`prisma/schema/${f}`); } catch { /* none readable */ } }
  for (const [abs, rel] of sqlFiles) {
    if (prismaSchemas.length && /(^|\/)prisma\/migrations\//.test(rel)) continue;
    perFile(gaps, rel, () => parseSql(decode(readFileSync(abs)), rel, sql));
  }
  const prisma = { models: new Map(), provider: null, relationMode: null, files: [] };
  for (const rel of prismaSchemas) perFile(gaps, rel, () => { parsePrisma(decode(readFileSync(join(root, rel))).replace(/^﻿/, ''), rel, prisma); prisma.files.push(rel); });
  return { sql, prisma, sqlFiles: sqlFiles.map(([, r]) => r) };
}

// Whether an index on t starts with col (any of cols).
export function leads(t, cols) {
  return t.indexes.some((ix) => cols.includes(ix.cols[0]));
}

// ---- SQL ----

// Comments and string contents become spaces, so offsets and lines stay.
function blank(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') { const e = text.indexOf('\n', i); const end = e < 0 ? text.length : e; out += ' '.repeat(end - i); i = end; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? text.length : e + 2; out += text.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    if (c === "'") { let j = i + 1; while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1; out += `'${text.slice(i + 1, j).replace(/[^\n]/g, ' ')}'`; i = j + 1; continue; }
    out += c; i++;
  }
  return out;
}
function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (pos) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; } return { line: lo + 1, column: pos - starts[lo] + 1 }; };
}
// The offset of the parenthesis closing the one at open, or -1.
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) return i; }
  return -1;
}
// Top-level comma-separated parts of s, with their offsets.
function parts(s, base) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i <= s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if ((c === ',' && depth === 0) || i === s.length) { const raw = s.slice(start, i); const lead = raw.length - raw.trimStart().length; out.push({ text: raw.trim(), at: base + start + lead }); start = i + 1; }
  }
  return out.filter((p) => p.text);
}
const ident = (s) => s.replace(/"/g, '').trim().toLowerCase();
const colList = (s) => s.split(',').map((c) => { const t = c.trim().replace(/\s+(asc|desc|nulls\s+(first|last)|collate\s+\S+)\b.*$/i, ''); return /^"?\w+"?$/.test(t) ? ident(t) : `expr:${t.toLowerCase()}`; });

function parseSql(raw, file, tables) {
  const text = blank(raw);
  const low = text.toLowerCase();
  const at = lineIndex(text);
  const table = (name, pos) => {
    const key = ident(name.split('.').pop());
    if (!tables.has(key)) tables.set(key, { name: key, kind: 'sql', file, line: at(pos).line, columns: new Map(), indexes: [], fks: [] });
    return tables.get(key);
  };
  const name = String.raw`((?:"?\w+"?\.)?"?\w+"?)`;
  const constraint = (t, item, pos) => {
    const s = item.toLowerCase().replace(/^constraint\s+"?\w+"?\s+/, '');
    let m;
    if ((m = s.match(/^primary\s+key\s*\(([^)]*)\)/))) t.indexes.push({ cols: colList(m[1]), unique: true, file, line: at(pos).line });
    else if ((m = s.match(/^unique\s*(?:nulls\s+(?:not\s+)?distinct\s*)?\(([^)]*)\)/))) t.indexes.push({ cols: colList(m[1]), unique: true, file, line: at(pos).line });
    else if ((m = s.match(/^foreign\s+key\s*\(([^)]*)\)\s*references\s+(?:"?\w+"?\.)?"?(\w+)"?/))) t.fks.push({ cols: colList(m[1]), ref: m[2], file, ...at(pos) });
    else return false;
    return true;
  };
  const column = (t, item, pos) => {
    const m = item.match(/^("?\w+"?)\s+("?[\w.]+"?)/);
    if (!m) return;
    const col = ident(m[1]);
    const type = m[2].toLowerCase().replace(/"/g, '');
    const s = item.toLowerCase();
    t.columns.set(col, { type, ...at(pos), low: LOW_SELECTIVITY_SQL.test(type) });
    if (/\bprimary\s+key\b/.test(s)) t.indexes.push({ cols: [col], unique: true, file, line: at(pos).line });
    else if (/\bunique\b/.test(s)) t.indexes.push({ cols: [col], unique: true, file, line: at(pos).line });
    const r = s.match(/\breferences\s+(?:"?\w+"?\.)?"?(\w+)"?/);
    if (r) t.fks.push({ cols: [col], ref: r[1], file, ...at(pos) });
  };

  for (const m of low.matchAll(new RegExp(String.raw`\bcreate\s+(?:(?:global\s+|local\s+)?(?:temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?${name}\s*\(`, 'g'))) {
    const open = m.index + m[0].length - 1;
    const close = closing(text, open);
    if (close < 0) continue;
    const t = table(m[1], m.index);
    for (const p of parts(text.slice(open + 1, close), open + 1)) {
      if (/^(constraint|primary\s+key|unique|foreign\s+key|check|exclude|like)\b/i.test(p.text)) { constraint(t, p.text, p.at); continue; }
      column(t, p.text, p.at);
    }
  }
  for (const m of low.matchAll(new RegExp(String.raw`\bcreate\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:"?\w+"?\s+)?on\s+(?:only\s+)?${name}\s*(?:using\s+\w+\s*)?\(`, 'g'))) {
    const open = m.index + m[0].length - 1;
    const close = closing(text, open);
    if (close < 0) continue;
    table(m[2], m.index).indexes.push({ cols: colList(text.slice(open + 1, close)), unique: !!m[1], file, line: at(m.index).line });
  }
  for (const m of low.matchAll(new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${name}\s+`, 'g'))) {
    const start = m.index + m[0].length;
    const end = low.indexOf(';', start);
    const t = table(m[1], m.index);
    for (const p of parts(text.slice(start, end < 0 ? text.length : end), start)) {
      const s = p.text.replace(/^add\s+/i, '');
      if (s === p.text) continue;
      if (/^column\s+/i.test(s) || !/^(constraint|primary\s+key|unique|foreign\s+key|check|exclude)\b/i.test(s)) column(t, s.replace(/^column\s+(if\s+not\s+exists\s+)?/i, ''), p.at + p.text.indexOf(s.replace(/^column\s+(if\s+not\s+exists\s+)?/i, '')));
      else constraint(t, s, p.at);
    }
  }
}

// ---- Prisma ----

function parsePrisma(text, file, out) {
  const lines = text.split(/\r?\n/);
  const enums = new Set();
  for (const l of lines) { const e = l.match(/^\s*enum\s+(\w+)\s*\{/); if (e) enums.add(e[1]); }
  let model = null;
  let block = null;
  lines.forEach((raw, i) => {
    const line = i + 1;
    const l = raw.replace(/\/\/.*$/, '');
    const t = l.trim();
    if (!model && !block) {
      const m = t.match(/^model\s+(\w+)\s*\{/);
      if (m) { model = { name: m[1], kind: 'prisma', file, line, columns: new Map(), indexes: [], fks: [], fields: new Map() }; return; }
      const d = t.match(/^(datasource|generator)\s+\w+\s*\{/);
      if (d) block = d[1];
      return;
    }
    if (block) {
      if (t === '}') { block = null; return; }
      const p = t.match(/^provider\s*=\s*"(\w+)"/);
      if (p && block === 'datasource') out.provider = p[1];
      const r = t.match(/^relationMode\s*=\s*"(\w+)"/);
      if (r) out.relationMode = r[1];
      return;
    }
    if (t === '}') {
      model.closeLine = line;
      out.models.set(model.name[0].toLowerCase() + model.name.slice(1), model);
      model = null;
      return;
    }
    const attr = t.match(/^@@(id|unique|index)\s*\(\s*(?:fields\s*:\s*)?\[([^\]]*)\]/);
    if (attr) { model.indexes.push({ cols: fieldList(attr[2]), unique: attr[1] !== 'index', file, line }); return; }
    const map = t.match(/^@@map\s*\(\s*"([^"]+)"/);
    if (map) { model.map = map[1]; return; }
    const f = t.match(/^(\w+)\s+(\w+)(\[\]|\?)?(.*)$/);
    if (!f) return;
    const [, field, type, mod, rest] = f;
    const column = raw.indexOf(field) + 1;
    if (PRISMA_SCALARS.has(type) || enums.has(type)) {
      model.columns.set(field, { type, line, column, low: type === 'Boolean' || enums.has(type) });
      if (/@id\b/.test(rest) || /@unique\b/.test(rest)) model.indexes.push({ cols: [field], unique: true, file, line });
    } else if (mod !== '[]') {
      const rel = rest.match(/@relation\s*\(([^)]*)\)/);
      const fields = rel?.[1].match(/fields\s*:\s*\[([^\]]*)\]/);
      if (fields) model.fks.push({ cols: fieldList(fields[1]), ref: type, file, line, column, field });
    }
  });
  // A foreign key points at its scalar field's line.
  for (const m of out.models.values()) for (const fk of m.fks) { const c = m.columns.get(fk.cols[0]); if (c) { fk.line = c.line; fk.column = c.column; } }
}
const fieldList = (s) => s.split(',').map((x) => x.trim().replace(/\(.*$/, '').trim()).filter(Boolean);
