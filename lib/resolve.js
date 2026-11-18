// Following identifiers through a TypeScript program (lib/program.js): what
// an identifier names, where an import comes from, what an expression is as
// far as the checks go, and the keys of an options object. Shared by the
// checks; nothing here knows a check's rules.

import { ts, relOf } from './program.js';

export const MAX_DEPTH = 6;
export const UNKNOWN = { k: 'unknown' };

export function unwrap(e) {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e))) e = e.expression;
  return e;
}

export const isRequire = (e) => e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'require' && e.arguments.length === 1 && ts.isStringLiteralLike(e.arguments[0]);

// Where an import alias comes from: { module, name }, or null.
export function importOf(decl) {
  if (!decl) return null;
  if (ts.isImportClause(decl)) return { module: decl.parent.moduleSpecifier.text, name: 'default' };
  if (ts.isNamespaceImport(decl)) return { module: decl.parent.parent.moduleSpecifier.text, name: '*' };
  if (ts.isImportSpecifier(decl)) return { module: decl.parent.parent.parent.moduleSpecifier.text, name: (decl.propertyName ?? decl.name).text };
  if (ts.isImportEqualsDeclaration(decl) && ts.isExternalModuleReference(decl.moduleReference)) return { module: decl.moduleReference.expression.text, name: '*' };
  if (ts.isVariableDeclaration(decl) && isRequire(unwrap(decl.initializer))) return { module: unwrap(decl.initializer).arguments[0].text, name: '*' };
  if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent) && ts.isVariableDeclaration(decl.parent.parent) && isRequire(unwrap(decl.parent.parent.initializer))) {
    return { module: unwrap(decl.parent.parent.initializer).arguments[0].text, name: (decl.propertyName ?? decl.name).text };
  }
  return null;
}

// What an identifier names: { decl } in the project, { import } from a
// module the program does not hold, or null for a global.
export function declOf(cx, id) {
  let s = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
    ? cx.checker.getShorthandAssignmentValueSymbol(id.parent)
    : cx.checker.getSymbolAtLocation(id);
  if (!s) return null;
  if (s.flags & ts.SymbolFlags.Alias) {
    const target = cx.checker.getAliasedSymbol(s);
    const d = target?.valueDeclaration ?? target?.declarations?.[0];
    if (d && relOf(d.getSourceFile().fileName) !== null && !importOf(d)) return { decl: d };
    const imp = importOf(d) ?? importOf(s.declarations?.[0]);
    return imp ? { import: imp } : { decl: null };
  }
  const d = s.valueDeclaration ?? s.declarations?.[0];
  if (!d) return { decl: null };
  const imp = importOf(d);
  return imp ? { import: imp } : { decl: d };
}

// What an expression is, as far as clients go.
export function origin(cx, e, depth = 0) {
  e = unwrap(e);
  if (!e || depth > MAX_DEPTH) return UNKNOWN;
  if (ts.isIdentifier(e)) {
    const r = declOf(cx, e);
    if (!r) return { k: 'global', name: e.text };
    if (r.import) return { k: 'import', module: r.import.module, path: [r.import.name] };
    const d = r.decl;
    if (!d) return UNKNOWN;
    if (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.initializer) return origin(cx, d.initializer, depth + 1);
    if (ts.isParameter(d)) return { k: 'param', decl: d };
    return { k: 'local', decl: d };
  }
  if (ts.isPropertyAccessExpression(e)) {
    const base = origin(cx, e.expression, depth + 1);
    if (base.k === 'global' && base.name === 'globalThis') return { k: 'global', name: e.name.text };
    if (base.k === 'import') return { k: 'import', module: base.module, path: [...base.path, e.name.text] };
    return { k: 'member', base, name: e.name.text, node: e };
  }
  if (ts.isCallExpression(e)) {
    const c = origin(cx, e.expression, depth + 1);
    if (isLib(c, 'axios', 'create')) return { k: 'axios-instance', node: e, config: e.arguments[0] };
    if (isLib(c, 'got', 'extend')) return { k: 'got-instance', node: e, options: [...e.arguments] };
    if (c.k === 'member' && c.base.k === 'got-instance' && c.name === 'extend') return { k: 'got-instance', node: e, parent: c.base, options: [...e.arguments] };
    return UNKNOWN;
  }
  if (ts.isNewExpression(e)) return { k: 'new', callee: origin(cx, e.expression, depth + 1), node: e };
  return UNKNOWN;
}

// Whether an origin is a module's default export (or the module itself) and,
// with `member`, that member of it.
export function isLib(o, module, member) {
  if (o.k !== 'import' || o.module !== module) return false;
  const [head, ...rest] = o.path;
  if (head !== 'default' && head !== '*') return false;
  return member === undefined ? rest.length === 0 : rest.length === 1 && rest[0] === member;
}
export const isGlobal = (o, name, member) => (member === undefined
  ? o.k === 'global' && o.name === name
  : o.k === 'member' && o.name === member && o.base.k === 'global' && o.base.name === name);

// Whether a variable is changed after it is declared (a property assigned,
// Object.assign into it), so its initializer does not tell its keys.
export function mutated(cx, decl) {
  const sym = cx.checker.getSymbolAtLocation(decl.name);
  if (!sym) return true;
  const sameVar = (n) => ts.isIdentifier(n) && cx.checker.getSymbolAtLocation(n) === sym;
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = unwrap(n.left);
      if (sameVar(left) && !(decl.parent.flags & ts.NodeFlags.Const)) found = true;
      if ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) && sameVar(unwrap(left.expression))) found = true;
    }
    if (ts.isCallExpression(n) && n.arguments.length && sameVar(unwrap(n.arguments[0]))) {
      const callee = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'assign' && ts.isIdentifier(callee.expression) && callee.expression.text === 'Object') found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(decl.getSourceFile());
  return found;
}

// An object's keys as far as they can be known: entries in source order, each
// { key, value, node } or { open } where open is 'unknown' or { param }: keys
// may come from something that cannot be read, or from a parameter.
export function evalObject(cx, e, depth = 0) {
  e = unwrap(e);
  if (e === undefined) return { entries: [] };
  if (depth > MAX_DEPTH) return { entries: [{ open: 'unknown' }] };
  if (ts.isObjectLiteralExpression(e)) {
    const entries = [];
    for (const p of e.properties) {
      if (ts.isSpreadAssignment(p)) { entries.push(...evalObject(cx, p.expression, depth + 1).entries); continue; }
      const key = p.name ? nameOf(p.name) : null;
      if (key === null) { entries.push({ open: 'unknown' }); continue; }
      const value = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : null;
      entries.push({ key, value, node: p });
    }
    return { entries, literal: e };
  }
  if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return { entries: [] };
  if (ts.isIdentifier(e)) {
    const r = declOf(cx, e);
    if (!r || r.import || !r.decl) return { entries: [{ open: 'unknown' }] };
    const d = r.decl;
    if (ts.isParameter(d)) return { entries: [{ open: { param: d } }] };
    if (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.initializer && !mutated(cx, d)) return evalObject(cx, d.initializer, depth + 1);
  }
  return { entries: [{ open: 'unknown' }] };
}

export function nameOf(n) {
  if (ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)) return n.text;
  if (ts.isComputedPropertyName(n) && ts.isStringLiteralLike(n.expression)) return n.expression.text;
  return null;
}

// The last word on a key: { value, node }, { open }, or { absent: true }.
export function lookup(obj, key) {
  for (let i = obj.entries.length - 1; i >= 0; i--) {
    const en = obj.entries[i];
    if (en.open) return { open: en.open };
    if (en.key === key) return { value: en.value, node: en.node };
  }
  return { absent: true };
}


export const isZero = (v) => { v = unwrap(v); return !!v && ((ts.isNumericLiteral(v) && Number(v.text.replaceAll('_', '')) === 0) || v.kind === ts.SyntaxKind.FalseKeyword || v.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(v) && v.text === 'undefined')); };

// The name of the nearest named function around a node (anonymous callbacks
// are passed over), or at module level the variable it initialises.
export function symbolAt(node) {
  let variable;
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) { const name = functionName(n); if (name) return name; continue; }
    if (ts.isClassDeclaration(n) && n.name) return n.name.text;
    if (variable === undefined && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) variable = n.name.text;
  }
  return variable;
}

export function functionName(fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  return undefined;
}

export const nameOfFunction = (fn) => functionName(fn) ?? 'a function';

