// Calls to another service, recognised as checks/no-timeout.js recognises
// them: fetch (the global, undici's, node-fetch), axios and its instances,
// got and its instances, and node:http(s) get and request. A call to a
// function of the project counts when that function makes such a call, up to
// MAX_DEPTH helpers down, so a client wrapped in a helper is still seen.

import { ts } from './program.js';
import { unwrap, declOf, origin, isLib, isGlobal } from './resolve.js';

const AXIOS_METHODS = new Set(['request', 'get', 'delete', 'head', 'options', 'post', 'put', 'patch', 'postForm', 'putForm', 'patchForm']);
const GOT_METHODS = new Set(['get', 'post', 'put', 'patch', 'head', 'delete', 'stream']);
const HTTP_MODULES = new Set(['http', 'https', 'node:http', 'node:https']);
const MAX_DEPTH = 3;

// The client a call uses directly: 'fetch', 'axios', 'got', 'node:http', or
// null.
export function clientOf(cx, call) {
  const o = origin(cx, call.expression);
  if (isGlobal(o, 'fetch') || (o.k === 'import' && o.module === 'undici' && o.path.at(-1) === 'fetch') || isLib(o, 'node-fetch')) return 'fetch';
  if (isLib(o, 'axios') || (o.k === 'import' && o.module === 'axios' && o.path.length === 2 && AXIOS_METHODS.has(o.path[1]) && (o.path[0] === 'default' || o.path[0] === '*'))) return 'axios';
  if (o.k === 'axios-instance' || (o.k === 'member' && o.base.k === 'axios-instance' && AXIOS_METHODS.has(o.name))) return 'axios';
  if (isLib(o, 'got') || (o.k === 'import' && o.module === 'got' && o.path.length === 2 && GOT_METHODS.has(o.path[1]) && (o.path[0] === 'default' || o.path[0] === '*'))) return 'got';
  if (o.k === 'got-instance' || (o.k === 'member' && o.base.k === 'got-instance' && GOT_METHODS.has(o.name))) return 'got';
  if (o.k === 'import' && HTTP_MODULES.has(o.module) && ['get', 'request'].includes(o.path.at(-1)) && o.path.length <= 2) return 'node:http';
  return null;
}

// The function of the project a call runs, when it can be found.
export function calleeFunction(cx, call) {
  const callee = unwrap(call.expression);
  const id = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : null;
  let fn = id ? declOf(cx, id)?.decl : null;
  if (fn && (ts.isVariableDeclaration(fn) || ts.isPropertyAssignment(fn)) && fn.initializer && ts.isFunctionLike(unwrap(fn.initializer))) fn = unwrap(fn.initializer);
  return fn && ts.isFunctionLike(fn) && fn.body ? fn : null;
}

// For a call, the outbound call it makes, directly or through helpers:
// { client, call } (call is the call to the client itself), or null.
export function outboundOf(cx, call, depth = 0, seen = new Set()) {
  const client = clientOf(cx, call);
  if (client) return { client, call };
  if (depth >= MAX_DEPTH) return null;
  const fn = calleeFunction(cx, call);
  if (!fn || seen.has(fn)) return null;
  seen.add(fn);
  return outboundIn(cx, fn.body, depth + 1, seen);
}

// The first outbound call under a node, in source order, through helpers.
export function outboundIn(cx, node, depth = 0, seen = new Set()) {
  let found = null;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n)) found = outboundOf(cx, n, depth, seen);
    if (!found) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}
