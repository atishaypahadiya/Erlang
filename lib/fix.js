// Suggested fixes (fixtures/PLAN.md, ground rules). A fix changes the source
// of truth, never build output, and must not leave the code broken. A
// finding's erlang.fix is one of:
//   { kind: 'auto', edits, note? }       complete edits; applied and re-checked
//                                        by scripts/fix-test.js
//   { kind: 'guided', locations, note }  no edits: every place the person must
//                                        change, for fixes that take judgement
//
// The edit unit, shared with ITTEN and KERCKHOFFS so one fix step can apply
// any of their fixes:
//   { file, line, column, length, replace }  replace length characters at
//       line and column. line and column are 1-based; column and length
//       count UTF-16 code units, as JavaScript strings and TypeScript
//       positions do;
//   { create: file, content }  makes a file, which must not exist;
//   { remove: file }           deletes a file, which must exist.
// Every file is relative to the project root.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { OUTPUT_DIRS } from './sources.js';
import { ts } from './program.js';

export const isOutput = (path) => path.split('/').some((part) => OUTPUT_DIRS.has(part));

// An edit inserting text at a position of a source file.
function insertAt(file, sf, pos, text, length = 0) {
  const { line, character } = sf.getLineAndCharacterOfPosition(pos);
  return { file, line: line + 1, column: character + 1, length, replace: text };
}

// An edit adding `prop` (such as "timeout: 10_000") to an object literal, as
// its first property, in the literal's own layout: on a line of its own when
// the literal spans lines, inline when it does not.
export function insertProperty(file, obj, prop) {
  const sf = obj.getSourceFile();
  if (!obj.properties.length) return insertAt(file, sf, obj.getStart(sf), `{ ${prop} }`, obj.getEnd() - obj.getStart(sf));
  const first = obj.properties[0];
  const start = first.getStart(sf);
  const open = sf.getLineAndCharacterOfPosition(obj.getStart(sf)).line;
  const at = sf.getLineAndCharacterOfPosition(start);
  if (at.line === open) return insertAt(file, sf, start, `${prop}, `);
  const indent = sf.text.slice(sf.getPositionOfLineAndCharacter(at.line, 0), start);
  return /^[ \t]*$/.test(indent) ? insertAt(file, sf, start, `${prop},\n${indent}`) : null;
}

// An edit inserting text right after a node, such as a chained call after a
// call expression.
export function insertAfter(file, node, text) {
  return insertAt(file, node.getSourceFile(), node.getEnd(), text);
}

// An edit replacing a node's text, from its start (after leading trivia) to
// its end.
export function replaceNode(file, node, text) {
  const sf = node.getSourceFile();
  return insertAt(file, sf, node.getStart(sf), text, node.getEnd() - node.getStart(sf));
}

// An edit adding one argument after a call's last, or null when the call
// ends in a trailing comma (left to a person).
export function appendArgument(file, call, text) {
  const sf = call.getSourceFile();
  if (call.arguments.hasTrailingComma) return null;
  if (!call.arguments.length) return insertAt(file, sf, call.arguments.pos, text);
  return insertAt(file, sf, call.arguments[call.arguments.length - 1].getEnd(), `, ${text}`);
}

// The file an edit names, whatever its kind.
export const fileOf = (e) => e.file ?? e.create ?? e.remove;

// A path relative to the project root that stays inside it.
function inside(file) {
  if (typeof file !== 'string' || !file || isAbsolute(file) || /^[a-zA-Z]:/.test(file) || file.split(/[\\/]/).includes('..')) throw new Error(`fix: ${JSON.stringify(file)} is not a path relative to the project root`);
  if (isOutput(file)) throw new Error(`fix: ${file} is build output; a fix changes the source of truth`);
  return file;
}

// Applies auto fixes to a tree. A guided fix is refused. Identical edits are
// applied once. A file is created, removed or edited, never more than one of
// these in one apply. Edits in one file go from the end backwards; edits that
// overlap, or a position past the end of its line or of the file, are an
// error.
export function apply(root, fixes) {
  const seen = new Set();
  const edits = [];
  for (const f of fixes) {
    if (f.kind !== 'auto') throw new Error('fix: only auto fixes are applied; a guided fix is for a person');
    for (const e of f.edits) {
      inside(fileOf(e));
      const k = JSON.stringify(e);
      if (!seen.has(k)) { seen.add(k); edits.push(e); }
    }
  }
  const byFile = new Map();
  for (const e of edits) {
    const file = fileOf(e);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(e);
  }
  // Every check first, then every write: a refused apply changes nothing.
  const writes = [];
  for (const [file, list] of byFile) {
    const at = join(root, file);
    const kinds = new Set(list.map((e) => ('create' in e ? 'create' : 'remove' in e ? 'remove' : 'edit')));
    if (kinds.size > 1 || (!kinds.has('edit') && list.length > 1)) throw new Error(`fix: ${file} is ${[...kinds].map((k) => ({ edit: 'edited', create: 'created', remove: 'removed' })[k]).join(' and ')} in one apply`);
    if (kinds.has('create')) {
      if (existsSync(at)) throw new Error(`fix: ${file} already exists, so it cannot be created`);
      if (typeof list[0].content !== 'string') throw new Error(`fix: create ${file} has no content`);
      writes.push(() => { mkdirSync(dirname(at), { recursive: true }); writeFileSync(at, list[0].content); });
      continue;
    }
    if (!existsSync(at)) throw new Error(`fix: ${file} does not exist${kinds.has('edit') ? '; a new file is made with { create, content }' : ''}`);
    if (kinds.has('remove')) { writes.push(() => rmSync(at)); continue; }
    let text = readFileSync(at, 'utf8');
    const lineStarts = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    const lineEnd = (l) => { const next = l < lineStarts.length ? lineStarts[l] - 1 : text.length; return next > lineStarts[l - 1] && text[next - 1] === '\r' ? next - 1 : next; };
    const spans = list.map((e) => {
      if (![e.line, e.column, e.length].every(Number.isInteger) || e.line < 1 || e.column < 1 || e.length < 0 || typeof e.replace !== 'string') throw new Error(`fix: ${file}: malformed edit ${JSON.stringify(e)}`);
      if (e.line > lineStarts.length) throw new Error(`fix: ${file} has ${lineStarts.length} line(s), not ${e.line}`);
      const pos = lineStarts[e.line - 1] + e.column - 1;
      if (pos > lineEnd(e.line)) throw new Error(`fix: ${file}:${e.line} has no column ${e.column}`);
      if (pos + e.length > text.length) throw new Error(`fix: ${file}:${e.line}:${e.column}: length ${e.length} runs past the end of the file`);
      return { e, at: pos };
    }).sort((a, b) => b.at - a.at);
    for (let i = 1; i < spans.length; i++) if (spans[i].at + spans[i].e.length > spans[i - 1].at) throw new Error(`fix: overlapping edits in ${file}`);
    for (const { e, at: p } of spans) text = text.slice(0, p) + e.replace + text.slice(p + e.length);
    writes.push(() => writeFileSync(at, text));
  }
  for (const w of writes) w();
}

// Syntax errors in a file after a fix, as "line:column" strings: a fix must
// leave every file it touches parseable.
export function syntaxErrors(path, text) {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) return [];
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.jsx$/.test(path) ? ts.ScriptKind.JSX : /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true, kind);
  return sf.parseDiagnostics.map((d) => { const p = sf.getLineAndCharacterOfPosition(d.start); return `${p.line + 1}:${p.character + 1}`; });
}
