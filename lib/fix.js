// Suggested fixes (fixtures/PLAN.md, ground rules). A fix changes the source
// of truth, never build output, and must not leave the code broken. A
// finding's erlang.fix is one of:
//   { kind: 'auto', edits, note? }       complete edits; applied and re-checked
//                                        by scripts/fix-test.js
//   { kind: 'guided', locations, note }  no edits: every place the person must
//                                        change, for fixes that take judgement
//
// An edit is { file, line, column, length, replace }: replace length
// characters at line and column (1-based; columns count UTF-16 code units, as
// JavaScript strings and TypeScript positions do). The same shape as
// KERCKHOFFS's lib/fix.js, so one fix step can apply either specialist's.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

// An edit adding one argument after a call's last, or null when the call
// ends in a trailing comma (left to a person).
export function appendArgument(file, call, text) {
  const sf = call.getSourceFile();
  if (call.arguments.hasTrailingComma) return null;
  if (!call.arguments.length) return insertAt(file, sf, call.arguments.pos, text);
  return insertAt(file, sf, call.arguments[call.arguments.length - 1].getEnd(), `, ${text}`);
}

// Applies auto fixes to a tree. A guided fix, or an edit to build output, is
// refused. Identical edits are applied once; edits in one file go from the
// end backwards, and edits that overlap are an error.
export function apply(root, fixes) {
  const seen = new Set();
  const edits = [];
  for (const f of fixes) {
    if (f.kind !== 'auto') throw new Error('fix: only auto fixes are applied; a guided fix is for a person');
    for (const e of f.edits) {
      if (isOutput(e.file)) throw new Error(`fix: ${e.file} is build output; a fix changes the source of truth`);
      const k = JSON.stringify(e);
      if (!seen.has(k)) { seen.add(k); edits.push(e); }
    }
  }
  const byFile = new Map();
  for (const e of edits) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  for (const [file, list] of byFile) {
    let text = readFileSync(join(root, file), 'utf8');
    const lineStarts = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    const spans = list.map((e) => ({ e, at: lineStarts[e.line - 1] + e.column - 1 })).sort((a, b) => b.at - a.at);
    for (let i = 1; i < spans.length; i++) if (spans[i].at + spans[i].e.length > spans[i - 1].at) throw new Error(`fix: overlapping edits in ${file}`);
    for (const { e, at } of spans) text = text.slice(0, at) + e.replace + text.slice(at + e.length);
    writeFileSync(join(root, file), text);
  }
}

// Syntax errors in a file after a fix, as "line:column" strings: a fix must
// leave every file it touches parseable.
export function syntaxErrors(path, text) {
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.jsx$/.test(path) ? ts.ScriptKind.JSX : /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true, kind);
  return sf.parseDiagnostics.map((d) => { const p = sf.getLineAndCharacterOfPosition(d.start); return `${p.line + 1}:${p.character + 1}`; });
}
