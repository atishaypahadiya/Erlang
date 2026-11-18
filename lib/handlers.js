// Request handlers, and the code a request can reach from them. Checks that
// judge what a request costs (n-plus-one, per-row-writes) report only code a
// handler reaches (research/first-check.md, decision 5).
//
// Found in the source, with no configuration:
//   Express    app.get('/path', ...fns) and the other verbs, router.route(...)
//              .get(fn), on express() or express.Router(); a router mounted
//              with app.use('/prefix', router) has the prefix added.
//   Fastify    app.get('/path', [opts,] fn), app.route({ method, url,
//              handler }), on fastify() or on the instance a plugin
//              receives, with the prefix it is registered under.
//   node:http  http.createServer(fn) and https.createServer(opts, fn); no
//              method or route.
//   Next.js    the GET, POST, ... exports of app/**/route.{js,ts}, with the
//              route from the folders; the default export of pages/api/**,
//              with no method.
// A project adds others, or names those ERLANG cannot see, in
// erlang.config.json (the brief):
//   { "handlers": [{ "file": "src/worker.js", "function": "handle",
//                    "method": "POST", "route": "/jobs" }] }
//
// Reachability: a handler's function, every function it calls or passes on
// that resolves to a declaration in the project, and so on, up to
// MAX_REACH calls deep. Code inside a reachable function is reachable.

import { ts, relOf } from './program.js';
import { unwrap, declOf, origin, isLib, nameOf } from './resolve.js';
import { perFile } from './isolate.js';

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const NEXT_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const PLUGIN_PARAM = /^(app|fastify|server|instance|router|api)$/;
const MAX_REACH = 8;

const isFunction = (n) => !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n));

// The function an expression names: inline, declared, or a variable holding one.
export function functionOf(cx, e) {
  e = unwrap(e);
  if (!e) return null;
  if (isFunction(e)) return e;
  if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return null;
  const r = declOf(cx, ts.isIdentifier(e) ? e : e.name);
  const d = r?.decl;
  if (!d) return null;
  if (isFunction(d)) return d;
  if ((ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer && isFunction(unwrap(d.initializer))) return unwrap(d.initializer);
  return null;
}

// handlers: [{ fn, framework, endpoint?, label, file }]; reach(node) gives
// the handlers whose requests run the code at node; requestParam(decl)
// whether a parameter is a handler's request; notes for brief entries that
// name nothing.
export function findHandlers(cx, rels, gaps, brief = []) {
  const calls = [];
  const imports = new Set();
  for (const rel of rels) {
    perFile(gaps, rel, () => {
      const visit = (n) => {
        if (ts.isCallExpression(n)) calls.push(n);
        if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)) imports.add(n.moduleSpecifier.text);
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require' && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) imports.add(n.arguments[0].text);
        ts.forEachChild(n, visit);
      };
      visit(cx.sourceFile(rel));
    });
  }
  const handlers = [];
  const add = (fn, framework, method, route, how) => {
    if (!fn || handlers.some((h) => h.fn === fn && h.method === method && h.route === route)) return;
    const endpoint = method && route ? { method, route } : undefined;
    handlers.push({ fn, framework, endpoint, label: endpoint ? `${method} ${route}` : how, file: relOf(fn.getSourceFile().fileName) });
  };

  // What kind of app an expression is: { kind, prefix } or null.
  const appOf = (e, depth = 0) => {
    e = unwrap(e);
    if (!e || depth > 4) return null;
    if (ts.isCallExpression(e)) {
      const o = origin(cx, e.expression);
      if (isLib(o, 'express') || isLib(o, 'express', 'Router') || (o.k === 'import' && o.module === 'express' && o.path.join('.') === 'Router')) return { kind: 'express', prefix: '' };
      if (isLib(o, 'fastify') || (o.k === 'import' && o.module === 'fastify' && ['fastify', 'Fastify'].includes(o.path.join('.')))) return { kind: 'fastify', prefix: '' };
      return null;
    }
    if (!ts.isIdentifier(e)) return null;
    const d = declOf(cx, e)?.decl;
    if (!d) return null;
    if (ts.isVariableDeclaration(d) && d.initializer) {
      const app = appOf(d.initializer, depth + 1);
      return app && app.kind === 'express' ? { ...app, prefix: mountPrefix(d) } : app;
    }
    if (ts.isParameter(d) && isFunction(d.parent) && d.parent.parameters[0] === d) {
      const reg = registration(d.parent, depth);
      if (reg) return reg;
      if (ts.isIdentifier(d.name) && PLUGIN_PARAM.test(d.name.text)) {
        if (imports.has('fastify')) return { kind: 'fastify', prefix: '' };
        if (imports.has('express')) return { kind: 'express', prefix: '' };
      }
    }
    return null;
  };
  // A Fastify plugin: fn passed to app.register(fn, { prefix }).
  const registration = (fn, depth) => {
    for (const c of calls) {
      const callee = unwrap(c.expression);
      if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'register' || functionOf(cx, c.arguments[0]) !== fn) continue;
      const parent = appOf(callee.expression, depth + 1);
      if (parent?.kind !== 'fastify') continue;
      return { kind: 'fastify', prefix: parent.prefix + literalProp(c.arguments[1], 'prefix') };
    }
    return null;
  };
  // An Express router mounted with app.use('/prefix', router).
  const mountPrefix = (decl) => {
    const sym = cx.checker.getSymbolAtLocation(decl.name);
    for (const c of calls) {
      const callee = unwrap(c.expression);
      if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'use' || c.arguments.length < 2) continue;
      const path = unwrap(c.arguments[0]);
      if (!ts.isStringLiteralLike(path)) continue;
      for (const a of c.arguments.slice(1).map(unwrap)) {
        if (!ts.isIdentifier(a)) continue;
        const target = cx.checker.getSymbolAtLocation(a);
        const s = target && target.flags & ts.SymbolFlags.Alias ? cx.checker.getAliasedSymbol(target) : target;
        if (s === sym) return path.text.replace(/\/$/, '');
      }
    }
    return '';
  };
  const literalProp = (obj, key) => {
    obj = unwrap(obj);
    if (!obj || !ts.isObjectLiteralExpression(obj)) return '';
    for (const p of obj.properties) if (ts.isPropertyAssignment(p) && nameOf(p.name) === key && ts.isStringLiteralLike(unwrap(p.initializer))) return unwrap(p.initializer).text.replace(/\/$/, '');
    return '';
  };
  const join = (prefix, path) => (`${prefix}${path === '/' && prefix ? '' : path}` || '/');

  for (const c of calls) {
    const callee = unwrap(c.expression);
    if (!ts.isPropertyAccessExpression(callee)) continue;
    const name = callee.name.text;
    // http.createServer(fn), https.createServer(opts, fn)
    if (name === 'createServer') {
      const o = origin(cx, callee);
      if (o.k === 'import' && ['http', 'https', 'node:http', 'node:https', 'http2', 'node:http2'].includes(o.module)) {
        add(functionOf(cx, c.arguments.at(-1)), 'node:http', null, null, `the ${o.module.replace(/^node:/, '')} request handler`);
      }
      continue;
    }
    // app.route({ method, url, handler }) (Fastify)
    if (name === 'route' && c.arguments.length === 1 && ts.isObjectLiteralExpression(unwrap(c.arguments[0]))) {
      const app = appOf(callee.expression);
      if (app?.kind !== 'fastify') continue;
      const obj = unwrap(c.arguments[0]);
      const prop = (k) => obj.properties.find((p) => ts.isPropertyAssignment(p) && nameOf(p.name) === k)?.initializer;
      const url = unwrap(prop('url') ?? prop('path'));
      const methods = unwrap(prop('method'));
      const list = methods && ts.isStringLiteralLike(methods) ? [methods.text] : methods && ts.isArrayLiteralExpression(methods) ? methods.elements.map(unwrap).filter(ts.isStringLiteralLike).map((m) => m.text) : [];
      const fn = functionOf(cx, prop('handler'));
      for (const m of list.length ? list : [null]) add(fn, 'fastify', m?.toUpperCase() ?? null, url && ts.isStringLiteralLike(url) ? join(app.prefix, url.text) : null, 'a Fastify route');
      continue;
    }
    if (!VERBS.has(name)) continue;
    // router.route('/path').get(fn) (Express)
    const recv = unwrap(callee.expression);
    let app, path, fns;
    if (ts.isCallExpression(recv) && ts.isPropertyAccessExpression(unwrap(recv.expression)) && unwrap(recv.expression).name.text === 'route' && recv.arguments[0] && ts.isStringLiteralLike(unwrap(recv.arguments[0]))) {
      app = appOf(unwrap(recv.expression).expression);
      path = unwrap(recv.arguments[0]).text;
      fns = c.arguments;
    } else {
      const first = unwrap(c.arguments[0]);
      if (!first || !ts.isStringLiteralLike(first) || !/^[/*]/.test(first.text)) continue;
      app = appOf(recv);
      path = first.text;
      fns = c.arguments.slice(1);
    }
    if (!app) continue;
    const method = name === 'all' ? null : name.toUpperCase();
    const route = join(app.prefix, path);
    if (app.kind === 'fastify') {
      // app.get(path, [options,] handler); the options may carry the handler.
      const last = fns.at(-1);
      let fn = functionOf(cx, last);
      if (!fn && last && ts.isObjectLiteralExpression(unwrap(last))) fn = functionOf(cx, unwrap(last).properties.find((p) => ts.isPropertyAssignment(p) && nameOf(p.name) === 'handler')?.initializer);
      add(fn, 'fastify', method, route, `a Fastify route for ${route}`);
    } else {
      for (const a of fns) add(functionOf(cx, a), 'express', method, route, `an Express route for ${route}`);
    }
  }

  // Next.js route files and pages API routes.
  for (const rel of rels) {
    const appRoute = rel.match(/(?:^|\/)app\/(.*?)\/?route\.[cm]?[jt]sx?$/);
    const pagesApi = rel.match(/(?:^|\/)pages\/(api(?:\/.*)?)\.[cm]?[jt]sx?$/);
    if (!appRoute && !pagesApi) continue;
    perFile(gaps, rel, () => {
      const sf = cx.sourceFile(rel);
      const route = appRoute ? nextRoute(appRoute[1]) : nextRoute(pagesApi[1].replace(/\/index$/, ''));
      for (const st of sf.statements) {
        const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        const isDefault = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
        if (appRoute && exported && ts.isFunctionDeclaration(st) && st.name && NEXT_VERBS.has(st.name.text)) add(st, 'next', st.name.text, route, null);
        if (appRoute && exported && ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && NEXT_VERBS.has(d.name.text)) add(functionOf(cx, d.initializer), 'next', d.name.text, route, null);
        }
        if (pagesApi && isDefault && ts.isFunctionDeclaration(st)) add(st, 'next', null, null, `the Next.js API route ${route}`);
        if (pagesApi && ts.isExportAssignment(st) && !st.isExportEquals) add(functionOf(cx, st.expression), 'next', null, null, `the Next.js API route ${route}`);
      }
    });
  }

  // The brief: handlers named in erlang.config.json.
  const notes = [];
  for (const b of brief) {
    const sf = rels.includes(b.file) ? cx.sourceFile(b.file) : null;
    let fn = null;
    if (sf) {
      const visit = (n) => {
        if (fn) return;
        if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && nameOf(n.name) === b.function) fn = n;
        else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === b.function && isFunction(unwrap(n.initializer))) fn = unwrap(n.initializer);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    if (!fn) { notes.push(`erlang.config.json: handler ${b.function} in ${b.file} matches nothing`); continue; }
    add(fn, 'brief', b.method ?? null, b.route ?? null, `${b.function} (erlang.config.json)`);
  }

  // Reachability.
  const reached = new Map();
  const queue = handlers.map((h) => [h.fn, h, 0]);
  const mark = (fn, h, depth) => {
    if (!reached.has(fn)) reached.set(fn, new Set());
    const set = reached.get(fn);
    if (set.has(h)) return;
    set.add(h);
    if (depth < MAX_REACH) queue.push([fn, h, depth]);
  };
  for (const h of handlers) { if (!reached.has(h.fn)) reached.set(h.fn, new Set()); reached.get(h.fn).add(h); }
  while (queue.length) {
    const [fn, h, depth] = queue.shift();
    const visit = (n) => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const callee = functionOf(cx, n.expression);
        if (callee) mark(callee, h, depth + 1);
        for (const a of n.arguments ?? []) { const f = ts.isIdentifier(unwrap(a)) ? functionOf(cx, a) : null; if (f) mark(f, h, depth + 1); }
      }
      ts.forEachChild(n, visit);
    };
    if (fn.body) visit(fn.body);
  }
  const reach = (node) => {
    const out = new Set();
    for (let n = node; n; n = n.parent) if (reached.has(n)) for (const h of reached.get(n)) out.add(h);
    return [...out];
  };
  const requestParam = (decl) => ts.isParameter(decl) && handlers.some((h) => h.fn.parameters?.[0] === decl);
  return { handlers, reach, requestParam, notes };
}

// app/(shop)/orders/[id]/ -> /orders/:id; [...slug] and [[...slug]] -> :slug*
function nextRoute(dir) {
  const parts = dir.split('/').filter((p) => p && !/^\(.*\)$/.test(p) && !p.startsWith('@'));
  return `/${parts.map((p) => p.replace(/^\[\[?\.\.\.(.+?)\]\]?$/, ':$1*').replace(/^\[(.+)\]$/, ':$1')).join('/')}`;
}
