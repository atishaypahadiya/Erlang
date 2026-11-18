// no-timeout (TMO-01; fixture L07): an outbound call with nothing that bounds
// how long it waits. Static: reads source, runs nothing.
//
// Clients, found by where they are imported from (research/first-check.md):
//   fetch      the global, undici's fetch, node-fetch. Bounded only by a
//              signal: Node's fetch has no overall timeout, and its 300 s
//              header and body timers restart on activity.
//   axios      the default instance and instances from axios.create. Bounded
//              by a timeout other than 0 (axios's default is 0, none) or a
//              signal, on the call, the instance or its defaults.
//   got        got and instances from got.extend. Bounded by a timeout or a
//              signal; got sets no timeout by default.
//   node:http  http and https get and request. Bounded by a signal, or by a
//   node:https timeout option or setTimeout on the request together with a
//              'timeout' handler that destroys or aborts it: the option alone
//              only emits an event (a warning when nothing ends the request).
//   pg         Pool and Client. Bounded when the config sets statement_timeout
//              or query_timeout, and connectionTimeoutMillis; pg's default
//              for each is no timeout.
//
// The type checker follows identifiers across the project's modules: an
// options object built elsewhere, an instance created in another file, and
// a fetch inside a helper whose signal comes from a parameter, which is
// judged at each of the helper's callers. What cannot be followed (a spread
// from a package, a value computed at run time) gives info, never error.
//
// Every finding carries a fix: auto when the call's shape is simple (add a
// signal, a timeout or the pool settings to an options object, or add the
// options argument), guided otherwise. The auto fix's 10 s is a starting
// value, not a measured one; its note says so.

import { ts, build, position, relOf } from '../lib/program.js';
import { MAX_DEPTH, unwrap, declOf, origin, isLib, isGlobal, mutated, evalObject, lookup, isZero, symbolAt, nameOfFunction } from '../lib/resolve.js';
import { readSources } from '../lib/sources.js';
import { perFile } from '../lib/isolate.js';
import { finding, fingerprint } from '../core/finding.js';
import { insertProperty, appendArgument, insertAfter } from '../lib/fix.js';

export const CHECK = 'no-timeout';
const RULES = ['TMO-01'];
const STRENGTH = 'MUST';
const MS = '10_000';
const SIGNAL = `signal: AbortSignal.timeout(${MS})`;
const AUTO_NOTE = '10 s is a starting value, not a measured one: set it from the dependency\'s measured latency (TMO-03), within a few multiples of its normal latency (TMO-04).';
const MAX_CALLER_DEPTH = 3;

const AXIOS_CONFIG_AT = { request: 0, get: 1, delete: 1, head: 1, options: 1, post: 2, put: 2, patch: 2, postForm: 2, putForm: 2, patchForm: 2 };
const GOT_METHODS = new Set(['get', 'post', 'put', 'patch', 'head', 'delete', 'stream']);
const HTTP_MODULES = new Set(['http', 'https', 'node:http', 'node:https']);

// ---- Verdicts: 'bounded', 'none', 'unknown', or { param, how } ----


// A signal expression: bounded when it is, or contains, a timeout.
function judgeSignal(cx, e, depth = 0) {
  e = unwrap(e);
  if (!e || e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return 'none';
  if (depth > MAX_DEPTH) return 'unknown';
  if (ts.isCallExpression(e)) {
    const o = origin(cx, e.expression);
    if (isGlobal(o, 'AbortSignal', 'timeout')) return 'bounded';
    if (isGlobal(o, 'AbortSignal', 'any') && e.arguments[0] && ts.isArrayLiteralExpression(unwrap(e.arguments[0]))) {
      const parts = unwrap(e.arguments[0]).elements.map((x) => judgeSignal(cx, x, depth + 1));
      return parts.includes('bounded') ? 'bounded' : 'unknown';
    }
    return 'unknown';
  }
  if (ts.isPropertyAccessExpression(e) && e.name.text === 'signal' && ts.isIdentifier(unwrap(e.expression))) {
    const r = declOf(cx, unwrap(e.expression));
    const d = r?.decl;
    if (d && ts.isVariableDeclaration(d) && d.initializer && ts.isNewExpression(unwrap(d.initializer)) && isGlobal(origin(cx, unwrap(d.initializer).expression), 'AbortController')) {
      return abortedByTimer(cx, d) ? 'bounded' : 'unknown';
    }
    return 'unknown';
  }
  if (ts.isIdentifier(e)) {
    const r = declOf(cx, e);
    if (!r || r.import || !r.decl) return 'unknown';
    if (ts.isParameter(r.decl)) return { param: r.decl, how: 'signal' };
    if (ts.isVariableDeclaration(r.decl) && r.decl.initializer && !mutated(cx, r.decl)) return judgeSignal(cx, r.decl.initializer, depth + 1);
  }
  return 'unknown';
}

// Whether an AbortController is aborted by a setTimeout in the scope that
// declares it: setTimeout(() => controller.abort(), ms).
function abortedByTimer(cx, decl) {
  const sym = cx.checker.getSymbolAtLocation(decl.name);
  let scope = decl.parent;
  while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  let found = false;
  const callsAbort = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'abort' && ts.isIdentifier(n.expression.expression) && cx.checker.getSymbolAtLocation(n.expression.expression) === sym) found = true;
    ts.forEachChild(n, callsAbort);
  };
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && isGlobal(origin(cx, n.expression), 'setTimeout') && n.arguments[0] && (ts.isArrowFunction(n.arguments[0]) || ts.isFunctionExpression(n.arguments[0]))) callsAbort(n.arguments[0].body);
    ts.forEachChild(n, visit);
  };
  if (scope) visit(scope);
  return found;
}

// fetch's options: bounded only by a signal.
function judgeFetchOptions(cx, init) {
  const obj = evalObject(cx, init);
  const s = lookup(obj, 'signal');
  if (s.absent) return { verdict: 'none', obj };
  if (s.open) return { verdict: s.open === 'unknown' ? 'unknown' : { param: s.open.param, how: 'object' }, obj };
  const j = judgeSignal(cx, s.value);
  return { verdict: j, obj };
}

// axios or got options: bounded by a timeout (not 0) or a signal.
function judgeTimeoutOptions(cx, e, { got = false } = {}) {
  const obj = evalObject(cx, e);
  const t = lookup(obj, 'timeout');
  const s = lookup(obj, 'signal');
  const tvNode = t.value ? unwrap(t.value) : null;
  const tv = t.absent ? 'none' : t.open ? 'unknown' : isZero(t.value) ? 'none'
    : got && tvNode && ts.isObjectLiteralExpression(tvNode) && !tvNode.properties.length ? 'none' : 'bounded';
  const sv = s.absent ? 'none' : s.open ? 'unknown' : (() => { const j = judgeSignal(cx, s.value); return typeof j === 'object' ? 'unknown' : j; })();
  const verdict = tv === 'bounded' || sv === 'bounded' ? 'bounded' : tv === 'unknown' || sv === 'unknown' ? 'unknown' : 'none';
  return { verdict, obj };
}

// ---- The check ----

export function run(root) {
  const { files, gaps } = readSources(root);
  const cx = { ...build(files), files };
  const findings = [];
  const stats = { files: files.size, calls: { fetch: 0, axios: 0, got: 0, 'node:http': 0, pg: 0 }, bounded: 0, deferred: 0 };

  // Every call in the program, by the function it calls, for helpers whose
  // deadline depends on a parameter; and the axios defaults set anywhere.
  const callers = new Map();
  const axiosDefaults = { global: false, instances: new Set() };
  for (const rel of [...files.keys()].sort()) {
    perFile(gaps, rel, () => {
      const visit = (n) => {
        if (ts.isCallExpression(n)) {
          const callee = unwrap(n.expression);
          const id = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : null;
          const r = id ? declOf(cx, id) : null;
          let fn = r?.decl;
          if (fn && ts.isVariableDeclaration(fn) && fn.initializer && ts.isFunctionLike(unwrap(fn.initializer))) fn = unwrap(fn.initializer);
          if (fn && ts.isFunctionLike(fn)) { if (!callers.has(fn)) callers.set(fn, []); callers.get(fn).push(n); }
        }
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'timeout' && !isZero(n.right)) {
          const defaults = unwrap(n.left.expression);
          if (ts.isPropertyAccessExpression(defaults) && defaults.name.text === 'defaults') {
            const o = origin(cx, defaults.expression);
            if (isLib(o, 'axios')) axiosDefaults.global = true;
            if (o.k === 'axios-instance') axiosDefaults.instances.add(o.node);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(cx.sourceFile(rel));
    });
  }

  const instances = new Map();
  const add = (f) => findings.push(f);

  for (const rel of [...files.keys()].sort()) {
    perFile(gaps, rel, () => {
      const visit = (n) => {
        if (ts.isCallExpression(n)) classifyCall(n);
        if (ts.isNewExpression(n)) classifyNew(n);
        ts.forEachChild(n, visit);
      };
      visit(cx.sourceFile(rel));
    });
  }

  function classifyCall(call) {
    const o = origin(cx, call.expression);
    const isFetch = isGlobal(o, 'fetch')
      || (o.k === 'import' && o.module === 'undici' && o.path.at(-1) === 'fetch')
      || isLib(o, 'node-fetch');
    if (isFetch) { stats.calls.fetch++; return onFetch(call); }
    if (isLib(o, 'axios') || (o.k === 'import' && o.module === 'axios' && o.path.length === 2 && o.path[1] in AXIOS_CONFIG_AT && (o.path[0] === 'default' || o.path[0] === '*'))) {
      stats.calls.axios++;
      return onAxios(call, o.path.length === 1 ? null : o.path[1], null);
    }
    if (o.k === 'axios-instance' || (o.k === 'member' && o.base.k === 'axios-instance' && o.name in AXIOS_CONFIG_AT)) {
      stats.calls.axios++;
      return onAxios(call, o.k === 'member' ? o.name : null, o.k === 'member' ? o.base : o);
    }
    if (isLib(o, 'got') || (o.k === 'import' && o.module === 'got' && o.path.length === 2 && GOT_METHODS.has(o.path[1]) && (o.path[0] === 'default' || o.path[0] === '*'))) {
      stats.calls.got++;
      return onGot(call, null);
    }
    if (o.k === 'got-instance' || (o.k === 'member' && o.base.k === 'got-instance' && GOT_METHODS.has(o.name))) {
      stats.calls.got++;
      return onGot(call, o.k === 'member' ? o.base : o);
    }
    if (o.k === 'import' && HTTP_MODULES.has(o.module) && ['get', 'request'].includes(o.path.at(-1)) && o.path.length <= 2) {
      stats.calls['node:http']++;
      return onHttp(call, o.module.replace(/^node:/, ''), o.path.at(-1));
    }
  }

  function classifyNew(n) {
    const o = origin(cx, n.expression);
    if (o.k === 'import' && o.module === 'pg' && ['Pool', 'Client'].includes(o.path.at(-1)) && o.path.length <= 2) {
      stats.calls.pg++;
      onPg(n, o.path.at(-1));
    }
  }

  // -- fetch --

  function onFetch(call) {
    let init = call.arguments[1];
    // fetch(new Request(url, init)): the request's own options.
    const first = unwrap(call.arguments[0]);
    if (!init && first && ts.isNewExpression(first) && isGlobal(origin(cx, first.expression), 'Request')) init = first.arguments?.[1];
    const { verdict, obj } = judgeFetchOptions(cx, init);
    if (verdict === 'bounded') { stats.bounded++; return; }
    if (typeof verdict === 'object') { stats.deferred++; return deferred(call, verdict, [call], 1); }
    if (verdict === 'unknown') return add(unresolved(call, 'fetch', 'its options or signal come from code ERLANG cannot read'));
    const fix = init === undefined && call.arguments.length === 1 ? auto(call, [appendArgument(fileOf(call), call, `{ ${SIGNAL} }`)])
      : obj.literal && unwrap(init) === obj.literal ? auto(call, [insertProperty(fileOf(call), obj.literal, SIGNAL)])
        : guided([call], 'Pass a signal with a deadline, such as signal: AbortSignal.timeout(ms), in the options this call gets.');
    add(make(call, 'fetch', 'error', `fetch${inName(call)} has no deadline: no signal is passed, and Node's fetch never times out a whole request by itself.`, fix));
  }

  // A fetch whose signal comes from a parameter of the function around it:
  // judged at each call of that function. chain: the calls from the
  // outermost caller in, so a finding names every place.
  function deferred(inner, { param, how }, chain, depth) {
    const fn = param.parent;
    const index = fn.parameters.indexOf(param);
    const calls = callers.get(fn) ?? [];
    if (!calls.length || depth > MAX_CALLER_DEPTH) {
      return add(unresolved(inner, 'fetch', depth > MAX_CALLER_DEPTH ? 'its signal is passed down more levels than ERLANG follows' : `its signal comes from a parameter of ${nameOfFunction(fn)}, and nothing in scope calls it`, chain));
    }
    for (const call of calls) {
      const arg = call.arguments[index] ?? param.initializer;
      const v = how === 'signal' ? judgeSignal(cx, arg) : judgeFetchOptions(cx, arg).verdict;
      const here = [call, ...chain];
      if (v === 'bounded') { stats.bounded++; continue; }
      if (typeof v === 'object') { deferred(inner, v, here, depth + 1); continue; }
      if (v === 'unknown') { add(unresolved(call, 'fetch', `the signal it passes to ${nameOfFunction(fn)} comes from code ERLANG cannot read`, here)); continue; }
      const obj = how === 'object' ? evalObject(cx, call.arguments[index]) : null;
      const fix = how === 'object' && call.arguments[index] === undefined && call.arguments.length === index
        ? auto(call, [appendArgument(fileOf(call), call, `{ ${SIGNAL} }`)])
        : how === 'object' && obj?.literal && unwrap(call.arguments[index]) === obj.literal
          ? auto(call, [insertProperty(fileOf(call), obj.literal, SIGNAL)])
          : guided(here, `Pass a signal with a deadline to ${nameOfFunction(fn)}, such as signal: AbortSignal.timeout(ms).`);
      add(make(here, 'fetch', 'error', `${symbolAt(call) ?? 'This code'} calls ${nameOfFunction(fn)} with no signal, so the fetch in it (${where(inner)}) has no deadline.`, fix, { via: true }));
    }
  }

  // -- axios --

  function onAxios(call, method, instance) {
    const at = method === null ? (call.arguments[0] && ts.isObjectLiteralExpression(unwrap(call.arguments[0])) ? 0 : 1) : AXIOS_CONFIG_AT[method];
    const config = call.arguments[at];
    const { verdict, obj } = judgeTimeoutOptions(cx, config);
    if (instance) {
      if (!instances.has(instance.node)) instances.set(instance.node, { kind: 'axios', origin: instance, none: [], unknown: [] });
      const rec = instances.get(instance.node);
      if (verdict === 'bounded') stats.bounded++;
      else rec[verdict].push(call);
      return;
    }
    if (verdict === 'bounded' || axiosDefaults.global) { stats.bounded++; return; }
    const name = `axios${method ? `.${method}` : ''}`;
    if (verdict === 'unknown') return add(unresolved(call, 'axios', 'its config comes from code ERLANG cannot read'));
    const fix = config === undefined && call.arguments.length === at ? auto(call, [appendArgument(fileOf(call), call, `{ timeout: ${MS} }`)])
      : obj.literal && unwrap(config) === obj.literal && lookup(obj, 'timeout').absent ? auto(call, [insertProperty(fileOf(call), obj.literal, `timeout: ${MS}`)])
        : guided([call], 'Give this call, or the axios defaults, a timeout other than 0.');
    add(make(call, 'axios', 'error', `${name}${inName(call)} has no timeout; axios's default is 0, which never times out.`, fix));
  }

  // -- got --

  function onGot(call, instance) {
    const at = call.arguments[0] && ts.isObjectLiteralExpression(unwrap(call.arguments[0])) ? 0 : 1;
    const options = call.arguments[at];
    const { verdict, obj } = judgeTimeoutOptions(cx, options, { got: true });
    if (instance) {
      if (!instances.has(instance.node)) instances.set(instance.node, { kind: 'got', origin: instance, none: [], unknown: [] });
      const rec = instances.get(instance.node);
      if (verdict === 'bounded') stats.bounded++;
      else rec[verdict].push(call);
      return;
    }
    if (verdict === 'bounded') { stats.bounded++; return; }
    if (verdict === 'unknown') return add(unresolved(call, 'got', 'its options come from code ERLANG cannot read'));
    const fix = options === undefined && call.arguments.length === 1 ? auto(call, [appendArgument(fileOf(call), call, `{ timeout: { request: ${MS} } }`)])
      : obj.literal && unwrap(options) === obj.literal && lookup(obj, 'timeout').absent ? auto(call, [insertProperty(fileOf(call), obj.literal, `timeout: { request: ${MS} }`)])
        : guided([call], 'Give this call, or the got instance, a timeout such as timeout: { request: ms }.');
    add(make(call, 'got', 'error', `got${inName(call)} has no timeout; got sets none by default.`, fix));
  }

  // An instance is judged once, at its creation, with every call on it.
  function judgeInstances() {
    for (const [node, rec] of instances) {
      const own = rec.kind === 'axios' ? instanceVerdictAxios(rec.origin) : instanceVerdictGot(rec.origin);
      if (own === 'bounded') { stats.bounded += rec.none.length + rec.unknown.length; continue; }
      const name = symbolAt(node);
      const label = `The ${rec.kind} instance${name ? ` ${name}` : ''}`;
      if (rec.none.length && own === 'none') {
        const config = rec.kind === 'axios' ? rec.origin.config : rec.origin.options[0];
        const obj = config ? evalObject(cx, config) : null;
        const prop = rec.kind === 'axios' ? `timeout: ${MS}` : `timeout: { request: ${MS} }`;
        const fix = config === undefined && node.arguments.length === 0 ? auto(node, [appendArgument(fileOf(node), node, `{ ${prop} }`)])
          : obj?.literal && unwrap(config) === obj.literal && lookup(obj, 'timeout').absent ? auto(node, [insertProperty(fileOf(node), obj.literal, prop)])
            : guided([node, ...rec.none], `Give the instance a timeout where it is created, or each call on it.`);
        const n = rec.none.length;
        add(make([node, ...rec.none], rec.kind, 'error', `${label} has no timeout${rec.kind === 'axios' ? ' (axios\'s default is 0, none)' : ''}, and ${n === 1 ? 'the call' : `${n} calls`} on it set${n === 1 ? 's' : ''} none: ${rec.none.map(where).join(', ')}.`, fix, { calls: rec.none.length }));
        continue;
      }
      const unclear = [...rec.none, ...rec.unknown];
      if (unclear.length) add(unresolved([node, ...unclear], rec.kind, own === 'unknown' ? 'its config comes from code ERLANG cannot read' : 'the config of the calls on it comes from code ERLANG cannot read'));
    }
  }
  const instanceVerdictAxios = (inst) => (axiosDefaults.instances.has(inst.node) ? 'bounded' : judgeTimeoutOptions(cx, inst.config).verdict);
  function instanceVerdictGot(inst) {
    const verdicts = inst.options.map((x) => judgeTimeoutOptions(cx, x, { got: true }).verdict);
    if (inst.parent) verdicts.push(instanceVerdictGot(inst.parent));
    return verdicts.includes('bounded') ? 'bounded' : verdicts.includes('unknown') ? 'unknown' : 'none';
  }

  // -- node:http and node:https --

  function onHttp(call, module, method) {
    const args = call.arguments.map(unwrap);
    // A callback: a function, an identifier naming one, or one named as
    // callbacks are (cb, callback, done, next, handler, on...).
    const isFn = (a) => {
      if (!a) return false;
      if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return true;
      if (!ts.isIdentifier(a)) return false;
      if (/^(cb|callback|done|next|handler|respond|on[A-Z]\w*)$/.test(a.text)) return true;
      const d = declOf(cx, a)?.decl;
      return !!(d && (ts.isFunctionDeclaration(d) || (ts.isVariableDeclaration(d) && d.initializer && ts.isFunctionLike(unwrap(d.initializer)))));
    };
    // The first argument is a URL or the options. A URL: a string, a template,
    // a concatenation, new URL(...), a variable holding one, or a name that
    // says so (url, href, endpoint...).
    const isUrl = (a, depth = 0) => {
      if (!a) return false;
      if (ts.isStringLiteralLike(a) || ts.isTemplateExpression(a) || ts.isBinaryExpression(a)) return true;
      if (ts.isNewExpression(a) && isGlobal(origin(cx, a.expression), 'URL')) return true;
      if (!ts.isIdentifier(a)) return false;
      if (/url|uri|href|endpoint|link/i.test(a.text)) return true;
      const d = declOf(cx, a)?.decl;
      return !!(d && ts.isVariableDeclaration(d) && d.initializer && depth < MAX_DEPTH && isUrl(unwrap(d.initializer), depth + 1));
    };
    let options;
    if (args[0] && !isUrl(args[0]) && !isFn(args[0])) options = args[0];
    else if (args[1] && !isFn(args[1])) options = args[1];
    const { verdict: sig } = judgeFetchOptions(cx, options);
    const obj = evalObject(cx, options);
    const t = lookup(obj, 'timeout');
    const option = !t.absent && !t.open && !isZero(t.value);
    const h = timeoutHandling(call);
    // The timeout option and req.setTimeout only emit 'timeout'; the request
    // ends only if a handler destroys or aborts it.
    if (sig === 'bounded' || ((option || h.timer) && h.destroys)) { stats.bounded++; return; }
    if (sig === 'unknown' || typeof sig === 'object' || t.open) return add(unresolved(call, `node:${module}`, 'its options come from code ERLANG cannot read'));
    const name = `${module}.${method}${inName(call)}`;
    if (option || h.timer) {
      const how = option ? 'the timeout option' : 'setTimeout on the request';
      if (h.handlers.length) {
        const fix = guided([call, ...h.handlers], 'Make the \'timeout\' handler end the request: call destroy() on it (req.destroy(new Error(\'request timed out\'))).');
        return add(make([call, ...h.handlers], `node:${module}`, 'warning', `${name} sets a timeout, but ${how} only emits a 'timeout' event, and its handler (${h.handlers.map(where).join(', ')}) does not destroy or abort the request, so the request still waits forever.`, fix));
      }
      const fix = auto(call, [insertAfter(fileOf(call), call, '.on(\'timeout\', function () { this.destroy(new Error(\'request timed out\')); })')]);
      return add(make(call, `node:${module}`, 'warning', `${name} sets a timeout, but ${how} only emits a 'timeout' event: nothing destroys the request when it fires, so the request still waits forever.`, fix));
    }
    const fix = guided([call], `Pass options with signal: AbortSignal.timeout(ms)${isFn(args.at(-1)) ? ' before the callback' : ''}, or set a timeout and destroy the request in its 'timeout' handler.`);
    add(make(call, `node:${module}`, 'error', `${name} has no deadline: no signal, no timeout, and no setTimeout on the request.`, fix));
  }

  // What the request this call returns does about time, from calls chained
  // on it or made on the variable it is assigned to (in the same file):
  //   timer:     setTimeout(ms[, handler]) is called on it
  //   handlers:  the functions given to on/once/addListener('timeout', ...)
  //              or as setTimeout's callback
  //   destroys:  one of those handlers calls destroy() or abort() on it
  function timeoutHandling(call) {
    const out = { timer: false, handlers: [], destroys: false };
    const consider = (c, sym) => {
      const name = c.expression.name.text;
      let fn = null;
      if (name === 'setTimeout') { if (c.arguments[0] && !isZero(c.arguments[0])) out.timer = true; fn = c.arguments[1]; }
      else if (['on', 'once', 'addListener', 'prependListener'].includes(name) && c.arguments[0] && ts.isStringLiteralLike(unwrap(c.arguments[0])) && unwrap(c.arguments[0]).text === 'timeout') fn = c.arguments[1];
      if (!fn) return;
      const body = handlerBody(unwrap(fn));
      out.handlers.push(fn);
      if (body && endsRequest(body.node, sym, body.loose)) out.destroys = true;
    };
    let n = call;
    while (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && n.parent.parent && ts.isCallExpression(n.parent.parent)) {
      consider(n.parent.parent, null);
      n = n.parent.parent;
    }
    const decl = n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent : null;
    if (decl) {
      const sym = cx.checker.getSymbolAtLocation(decl.name);
      const visit = (x) => {
        if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && ts.isIdentifier(x.expression.expression) && cx.checker.getSymbolAtLocation(x.expression.expression) === sym) consider(x, sym);
        ts.forEachChild(x, visit);
      };
      visit(decl.getSourceFile());
    }
    return out;
  }

  // A handler's body: an inline function's, or that of the function an
  // identifier names. For a named function the request is not in scope by
  // name, so any destroy() or abort() it makes counts (loose).
  function handlerBody(fn) {
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return { node: fn.body, loose: false };
    if (fn && ts.isIdentifier(fn)) {
      const d = declOf(cx, fn)?.decl;
      const f = d && ts.isVariableDeclaration(d) && d.initializer ? unwrap(d.initializer) : d;
      if (f && ts.isFunctionLike(f) && f.body) return { node: f.body, loose: true };
    }
    return null;
  }

  // Whether code calls destroy() or abort() on the request: on `this`, on the
  // request's variable, or (loose) on anything.
  function endsRequest(body, sym, loose) {
    let found = false;
    const visit = (x) => {
      if (found) return;
      if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && ['destroy', 'abort'].includes(x.expression.name.text)) {
        const target = unwrap(x.expression.expression);
        if (loose || target.kind === ts.SyntaxKind.ThisKeyword || (sym && ts.isIdentifier(target) && cx.checker.getSymbolAtLocation(target) === sym)) found = true;
      }
      ts.forEachChild(x, visit);
    };
    visit(body);
    return found;
  }

  // -- pg --

  function onPg(node, kind) {
    const config = node.arguments?.[0];
    const obj = evalObject(cx, config);
    const state = (keys) => {
      const r = keys.map((k) => lookup(obj, k));
      if (r.some((x) => !x.absent && !x.open && !isZero(x.value))) return 'set';
      return r.some((x) => x.open) ? 'unknown' : 'absent';
    };
    const query = state(['statement_timeout', 'query_timeout']);
    const connect = state(['connectionTimeoutMillis']);
    if (query === 'set' && connect === 'set') { stats.bounded++; return; }
    if (query === 'unknown' || connect === 'unknown') return add(unresolved(node, 'pg', 'its config comes from code ERLANG cannot read'));
    const missing = [query === 'absent' ? 'statement_timeout' : null, connect === 'absent' ? 'connectionTimeoutMillis' : null].filter(Boolean);
    const props = missing.map((k) => `${k}: ${MS}`).join(', ');
    const fix = config === undefined && (node.arguments?.length ?? 0) === 0 ? auto(node, [appendArgument(fileOf(node), node, `{ ${props} }`)])
      : obj.literal && unwrap(config) === obj.literal ? auto(node, [insertProperty(fileOf(node), obj.literal, props)])
        : guided([node], `Set ${missing.join(' and ')} in this ${kind}'s config.`);
    const name = symbolAt(node);
    const what = [query === 'absent' ? 'no statement_timeout or query_timeout, so a slow query can run forever' : null, connect === 'absent' ? (kind === 'Pool' ? 'no connectionTimeoutMillis, so waiting for a free connection can last forever' : 'no connectionTimeoutMillis, so connecting can wait forever') : null].filter(Boolean);
    add(make(node, 'pg', 'error', `The pg ${kind}${name ? ` ${name}` : ''} sets ${what.join(', and ')}; pg's default for each is no timeout.`, fix));
  }

  judgeInstances();

  // ---- Findings ----

  function fileOf(node) { return relOf(node.getSourceFile().fileName); }
  function where(node) { const p = position(node.expression && !ts.isNewExpression(node) ? node.expression : node); return `${fileOf(node)}:${p.line}`; }
  function locationOf(node) {
    const target = ts.isCallExpression(node) ? node.expression : node;
    const p = position(target);
    const symbol = symbolAt(node);
    return { file: fileOf(node), line: p.line, column: p.column, ...(symbol ? { symbol } : {}) };
  }
  function inName(node) { const s = symbolAt(node); return s ? ` in ${s}` : ''; }
  function auto(node, edits) {
    if (edits.some((e) => !e)) return guided([node], 'Add a deadline to this call; its shape is one ERLANG does not edit automatically.');
    return { kind: 'auto', edits, note: AUTO_NOTE };
  }
  function guided(nodes, note) {
    const seen = new Set();
    const locations = [];
    for (const n of [nodes].flat()) {
      const l = locationOf(n);
      const k = `${l.file}:${l.line}`;
      if (!seen.has(k)) { seen.add(k); locations.push({ file: l.file, line: l.line }); }
    }
    return { kind: 'guided', locations, note };
  }
  function unresolved(nodes, client, why, chain) {
    const list = chain ?? [nodes].flat();
    const head = list[0];
    const fix = guided([head], 'Set the deadline at this call, after anything spread into its options, so it does not depend on code ERLANG cannot read: signal: AbortSignal.timeout(ms) for fetch and http, timeout for axios and got, statement_timeout and connectionTimeoutMillis for pg.');
    return make(list, client, 'info', `Whether this ${client} call${inName(head)} has a deadline is unknown: ${why}.`, fix, { unresolved: true, via: !!chain && chain.length > 1 });
  }
  // A finding's parts: where it is and which client, and for a call through
  // a helper, the call inside the helper too. extra.via marks such a chain.
  function make(nodes, client, severity, message, fix, extra = {}) {
    const list = [nodes].flat();
    const locations = list.map(locationOf);
    const key = (l) => `${l.file}#${l.symbol ?? '<module>'}`;
    const keyParts = [key(locations[0]), client, ...(extra.via ? [key(locations.at(-1))] : [])];
    return { severity, client, message, fix, locations, keyParts, extra };
  }

  // Fingerprints: the check, the place and client, and an ordinal among
  // findings with the same parts, in file order.
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
      where: { locations: f.locations },
      extension: { strength: STRENGTH, client: f.client, ...(f.extra.unresolved ? { unresolved: true } : {}), ...(f.extra.calls ? { calls: f.extra.calls } : {}), fix: f.fix },
    });
  });
  return { findings: out, run: stats, incomplete: gaps };
}
