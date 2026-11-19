// Serves one fixture twin for the trace harness (scripts/trace.sh). Before
// it imports the twin it:
//   - makes every server the twin starts listen on 127.0.0.1, on a port the
//     system picks, whatever host and port the twin asked for;
//   - sends every outbound HTTP request the twin makes (node:http,
//     node:https, fetch) to the harness's stub on 127.0.0.1
//     (ERLANG_TRACE_STUB), as plain HTTP, with the host it meant in
//     x-erlang-host. Nothing the twin calls leaves the machine;
//   - answers the harness's probes over IPC: "pool" (the counts of the pool
//     the twin's src/db.js exports), "memory" (after a full collection, when
//     node runs with --expose-gc, with the responses answered so far), "loop-reset" and "loop" (the event loop's
//     delay since the last reset).
// Then it imports the twin's entry (trace.json "entry", or src/server.js,
// or src/app.js). If no server is listening once the import is done and the
// module exports `app`, it starts it. When the first server is listening it
// writes { port, routes } to <ready file>. Fastify routes come from its
// onRoute hook; Express routes from its router.
//
// Usage: node [--expose-gc] scripts/trace/serve.js <twin dir> <ready file> [entry]

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dir, ready, entryArg] = process.argv.slice(2);
if (!dir || !ready) {
  console.error('usage: node scripts/trace/serve.js <twin dir> <ready file> [entry]');
  process.exit(64);
}
const root = resolve(dir);

// ---- Every server on 127.0.0.1, on a port the system picks.
const servers = [];
// Responses the twin's HTTP servers finished, for the "memory" probe: a heap
// reading with the count it was taken at.
let answered = 0;
const counted = new WeakSet();
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (this instanceof http.Server && !counted.has(this)) { counted.add(this); this.on('request', (req, res) => res.on('finish', () => { answered++; })); }
  const cb = args.find((a) => typeof a === 'function');
  servers.push(this);
  return listen.call(this, { host: '127.0.0.1', port: 0 }, cb);
};

// ---- Every outbound HTTP request to the stub.
const stub = process.env.ERLANG_TRACE_STUB ?? '';
const [stubHost, stubPort] = stub.split(':');
const plainRequest = http.request;
function toStub(args) {
  let url = null;
  let opts = {};
  let cb;
  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    url = new URL(args[0]);
    if (args[1] && typeof args[1] === 'object') { opts = args[1]; cb = args[2]; } else cb = args[1];
  } else { opts = args[0] ?? {}; cb = args[1]; }
  const host = url ? url.host : `${opts.hostname ?? opts.host ?? 'localhost'}${opts.port ? `:${opts.port}` : ''}`;
  const path = url ? `${url.pathname}${url.search}` : (opts.path ?? '/');
  const { agent, ca, cert, key, servername, rejectUnauthorized, createConnection, lookup, socketPath, protocol, hostname, port, ...rest } = opts;
  if (!stubHost) throw new Error(`the twin called ${host}${path}, and the harness runs no stub`);
  const options = { ...rest, protocol: 'http:', host: stubHost, port: Number(stubPort), path, headers: { ...(opts.headers ?? {}), 'x-erlang-host': host } };
  return plainRequest(options, cb);
}
http.request = (...args) => toStub(args);
https.request = (...args) => toStub(args);
http.get = (...args) => { const r = toStub(args); r.end(); return r; };
https.get = (...args) => { const r = toStub(args); r.end(); return r; };
syncBuiltinESMExports();
const plainFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const req = input instanceof Request ? input : null;
  const u = new URL(req ? req.url : String(input));
  const headers = new Headers(init.headers ?? req?.headers ?? {});
  headers.set('x-erlang-host', u.host);
  if (!stubHost) throw new Error(`the twin called ${u.host}, and the harness runs no stub`);
  return plainFetch(`http://${stub}${u.pathname}${u.search}`, { method: req?.method, body: req?.body, duplex: req?.body ? 'half' : undefined, signal: req?.signal, ...init, headers });
};

// ---- Probes.
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
let dbModule = null;
process.on('message', async (m) => {
  const reply = (body) => process.send?.({ id: m.id, ...body });
  try {
    if (m.probe === 'pool') {
      dbModule ??= existsSync(join(root, 'src', 'db.js')) ? await import(pathToFileURL(join(root, 'src', 'db.js')).href) : {};
      const p = dbModule.pool;
      reply(p ? { total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount } : { error: 'no pool exported from src/db.js' });
    } else if (m.probe === 'memory') {
      if (global.gc) { global.gc(); global.gc(); }
      const u = process.memoryUsage();
      reply({ heapUsed: u.heapUsed, rss: u.rss, collected: !!global.gc, answered });
    // reset() also forgets the last tick, and the tick after it only notes
    // the time: wait for that tick, or a stretch that starts before it is
    // never recorded.
    } else if (m.probe === 'loop-reset') { loop.reset(); await new Promise((ok) => setTimeout(ok, 5)); reply({}); }
    // The delay of a stretch is recorded when the monitor's timer next runs:
    // wait for a timer and an immediate, so the stretch just ended is in.
    else if (m.probe === 'loop') { await new Promise((ok) => setTimeout(ok, 5)); await new Promise((ok) => setImmediate(ok)); reply({ maxMs: loop.max / 1e6, meanMs: loop.mean / 1e6, count: loop.count }); }
    else reply({ error: `unknown probe ${m.probe}` });
  } catch (e) { reply({ error: String(e?.message ?? e) }); }
});

// ---- The twin.
const entry = entryArg || (existsSync(join(root, 'src', 'server.js')) ? 'src/server.js' : 'src/app.js');
const fastifyRoutes = [];
const mod = await import(pathToFileURL(join(root, entry)).href);
const app = mod.app;
const isFastify = !!app && typeof app.addHook === 'function' && typeof app.inject === 'function';
// A Fastify app that awaited listen() when it loaded takes no more hooks; its
// routes are then unknown here, and trace.json names each request's route.
if (isFastify && !app.server.listening) app.addHook('onRoute', (r) => { for (const method of [r.method].flat()) if (method !== 'HEAD') fastifyRoutes.push({ method, url: r.url }); });
if (!servers.length) {
  if (isFastify) await app.listen({ host: '127.0.0.1', port: 0 });
  else if (app && typeof app.listen === 'function') await new Promise((ok) => app.listen(0, '127.0.0.1', ok));
  else throw new Error(`${entry} started no server and exports no app to start`);
}
const server = isFastify ? app.server : servers[0];
if (!server.listening) await new Promise((ok) => server.once('listening', ok));
const { address, port } = server.address();
if (address !== '127.0.0.1') throw new Error(`listening on ${address}, not 127.0.0.1`);

function expressRoutes(a) {
  const out = [];
  const walk = (stack) => {
    for (const layer of stack ?? []) {
      if (layer.route) for (const m of Object.keys(layer.route.methods)) { if (m !== '_all' && m !== 'head') out.push({ method: m.toUpperCase(), url: layer.route.path }); }
      else if (layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  walk((a.router ?? a._router)?.stack);
  return out;
}
const routes = isFastify ? fastifyRoutes : app ? expressRoutes(app) : [];
writeFileSync(`${ready}.part`, JSON.stringify({ port, routes }));
renameSync(`${ready}.part`, ready);
const close = () => Promise.all(servers.map((s) => new Promise((ok) => s.close(() => ok())))).then(() => process.exit(0));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { (isFastify ? app.close() : close()).then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
