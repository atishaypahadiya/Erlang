// pool-sizing (CAP-08, OVL-11; fixture L13): connection pools that, across
// every process a project deploys, can open more connections than the
// database accepts, and pools made once per request. Static: reads source
// and deployment files, runs nothing.
//
// The total: for each process the deployment files start (lib/deploy.js),
// how many run (replicas, an HPA's maxReplicas, PM2 instances) times the
// connections of each long-lived pool its code imports:
//   pg Pool        max, default 10 (research/first-check.md, C6);
//   pg Client      1;
//   Prisma 7 with @prisma/adapter-pg: the adapter's max, default 10 (C7);
//   Prisma without an adapter: its own pool, whose size is not in the code.
// The limit: the database's max_connections less the 3 reserved for
// superusers, from erlang.config.json (database.maxConnections) or a
// PostgreSQL service in the same deployment (default 100, C17).
//
// Reported:
//   - error: the total exceeds the limit. Unknown factors count as 1 (a PM2
//     instance count of max is at least 1), so the total is a floor and the
//     finding holds whatever they are;
//   - error: a pool or Prisma client made inside code a request handler
//     reaches, not kept (no ??=, no module variable): one per request;
//   - info, unresolved: pools in a deployed process, but the limit or a
//     count is unknown, or a pooler (PgBouncer) sits in front.
// A pool in a file no deployed process imports (a seed script, a test
// helper) is not counted.
//
// Fixes: when one pool's max can bring the total within the limit, it is
// set automatically (the largest pool); otherwise, and for a pool made per
// request, guided.

import { ts, build, position, relOf } from '../lib/program.js';
import { unwrap, declOf, evalObject, lookup, symbolAt, origin, isLib } from '../lib/resolve.js';
import { readSources } from '../lib/sources.js';
import { perFile } from '../lib/isolate.js';
import { findHandlers } from '../lib/handlers.js';
import { deployments, PG_RESERVED } from '../lib/deploy.js';
import { finding, fingerprint } from '../core/finding.js';
import { replaceNode, insertProperty } from '../lib/fix.js';

export const CHECK = 'pool-sizing';
const RULES = ['CAP-08', 'OVL-11'];
const STRENGTH = 'SHOULD';
const PG_DEFAULT_MAX = 10;

export function run(root, { handlers: brief = [], database = null } = {}) {
  const { files, gaps } = readSources(root);
  const cx = { ...build(files), files };
  const rels = [...files.keys()].sort();
  const H = findHandlers(cx, rels, gaps, brief);
  const { platforms, notes } = deployments(root, cx, files, gaps);
  const findings = [];

  // ---- Every pool and client made in the source ----

  const made = [];
  for (const rel of rels) {
    perFile(gaps, rel, () => {
      const visit = (n) => {
        if (ts.isNewExpression(n)) { const k = kindOf(n); if (k) made.push({ node: n, kind: k, file: rel }); }
        ts.forEachChild(n, visit);
      };
      visit(cx.sourceFile(rel));
    });
  }
  function kindOf(n) {
    const o = origin(cx, n.expression);
    if (o.k !== 'import') return null;
    if (isLib(o, 'pg', 'Pool') || (o.module === 'pg' && o.path.join('.') === 'Pool') || isLib(o, 'pg-pool')) return 'pg Pool';
    if (isLib(o, 'pg', 'Client') || (o.module === 'pg' && o.path.join('.') === 'Client')) return 'pg Client';
    if (o.module === '@prisma/adapter-pg' && o.path.at(-1) === 'PrismaPg') return 'PrismaPg';
    if (o.path.at(-1) === 'PrismaClient') return 'PrismaClient';
    return null;
  }
  const byNode = new Map(made.map((m) => [m.node, m]));
  // The construction a value comes from, through a const.
  const madeAt = (e) => {
    e = unwrap(e);
    if (!e) return null;
    if (byNode.has(e)) return byNode.get(e);
    if (ts.isIdentifier(e)) { const d = declOf(cx, e)?.decl; if (d && ts.isVariableDeclaration(d) && d.initializer) return madeAt(d.initializer); }
    return null;
  };
  // Where a construction's connections are: { at (a made entry), max, why,
  // value (the max node), options (an object literal) }.
  function sizeOf(m) {
    if (m.kind === 'pg Client') return { at: m, max: 1, why: 'a pg Client: one connection' };
    if (m.kind === 'PrismaClient') {
      const opts = evalObject(cx, m.node.arguments?.[0]);
      const adapter = lookup(opts, 'adapter');
      const a = !adapter.absent && !adapter.open ? madeAt(adapter.value) : null;
      if (a) return sizeOf(a);
      if (!adapter.absent) return { at: m, max: null, why: 'a Prisma client whose adapter ERLANG cannot read' };
      return { at: m, max: null, why: "Prisma's own pool, num_physical_cpus × 2 + 1 unless the URL sets connection_limit" };
    }
    if (m.kind === 'PrismaPg') {
      const inner = madeAt(m.node.arguments?.[0]);
      if (inner) return sizeOf(inner);
    }
    const obj = unwrap(m.node.arguments?.[0]);
    const opts = evalObject(cx, obj);
    const max = lookup(opts, 'max');
    const literal = obj && ts.isObjectLiteralExpression(obj) ? obj : null;
    if (max.open) return { at: m, max: null, why: `${m.kind} options ERLANG cannot read` };
    if (max.absent) return { at: m, max: PG_DEFAULT_MAX, why: `${m.kind} with no max: pg's default ${PG_DEFAULT_MAX}`, options: literal };
    const v = numberOf(max.value);
    return v === null ? { at: m, max: null, why: `${m.kind} max ${max.value.getText()}, not a number ERLANG can read`, value: max.value }
      : { at: m, max: v, why: `${m.kind} max ${v}`, value: max.value, literal: ts.isNumericLiteral(unwrap(max.value)) };
  }
  function numberOf(e, depth = 0) {
    e = unwrap(e);
    if (!e || depth > 3) return null;
    if (ts.isNumericLiteral(e)) return Number(e.text.replaceAll('_', ''));
    if (ts.isIdentifier(e)) { const d = declOf(cx, e)?.decl; if (d && ts.isVariableDeclaration(d) && d.initializer && (d.parent.flags & ts.NodeFlags.Const)) return numberOf(d.initializer, depth + 1); }
    return null;
  }
  // A construction inside another's arguments is part of it.
  const inner = (m) => { for (let n = m.node.parent; n && !ts.isFunctionLike(n) && !ts.isStatement(n); n = n.parent) if (ts.isNewExpression(n) && byNode.has(n)) return true; return false; };
  // How long a construction lives: 'module', 'kept' (made in a function and
  // stored outside it), 'request' (made per call in code a handler reaches),
  // or 'call' (made per call, no handler reaches it).
  function lifetime(m) {
    const fn = (() => { for (let n = m.node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n; return null; })();
    if (!fn) return 'module';
    for (let n = m.node, p = n.parent; p && p !== fn; n = p, p = p.parent) {
      if (ts.isBinaryExpression(p) && p.right === n && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken].includes(p.operatorToken.kind) && outside(p.left, fn)) return 'kept';
      if (ts.isParenthesizedExpression(p) || ts.isAwaitExpression(p) || ts.isConditionalExpression(p) || (ts.isBinaryExpression(p) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind))) continue;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && keptLater(p.name, fn)) return 'kept';
      break;
    }
    return H.handlers.length && H.reach(m.node).length ? 'request' : 'call';
  }
  // Whether a target is stored outside fn: a property (globalThis.x,
  // this.x, cache[key]) or a variable declared outside it.
  function outside(target, fn) {
    target = unwrap(target);
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) return true;
    if (ts.isIdentifier(target)) { const d = declOf(cx, target)?.decl; if (!d) return true; for (let n = d.parent; n; n = n.parent) if (n === fn) return false; return true; }
    return false;
  }
  // A local later stored outside fn (cache = pool).
  function keptLater(id, fn) {
    const sym = cx.checker.getSymbolAtLocation(id);
    let kept = false;
    const visit = (n) => {
      if (kept) return;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(unwrap(n.right)) && cx.checker.getSymbolAtLocation(unwrap(n.right)) === sym && outside(n.left, fn)) kept = true;
      ts.forEachChild(n, visit);
    };
    visit(fn.body ?? fn);
    return kept;
  }

  const owners = [];
  for (const m of made) perFile(gaps, m.file, () => { if (!inner(m)) owners.push({ ...m, life: lifetime(m), size: sizeOf(m) }); });

  // ---- Per request ----

  for (const o of owners.filter((x) => x.life === 'request')) {
    const reach = H.reach(o.node);
    const endpoints = [...new Set(reach.map((h) => h.label))];
    const who = symbolAt(o.node) ?? `The ${reach[0].label} handler`;
    const what = o.kind === 'PrismaClient' ? 'a Prisma client, with its own connection pool,' : o.kind === 'pg Client' ? 'a pg Client, a connection of its own,' : `a ${o.kind}`;
    const closes = /\.(end|\$disconnect)\s*\(/.test(enclosingText(o.node));
    findings.push({
      severity: 'error',
      message: `${who} makes ${what} on every request of ${endpoints.join(' and ')}${closes ? '' : ' and never closes it'}: connections grow with concurrent requests, past any pool's limit, until the database refuses them, and each request pays for a new connection.`,
      locations: [locationOf(o.node)],
      fix: { kind: 'guided', locations: [{ file: o.file, line: position(o.node).line }], note: `Make it once per process, at module level (or kept in a module variable on first use), and use that one here. Size it with the rest: pool-sizing counts it then.` },
      keyParts: [key(locationOf(o.node)), 'per-request'],
      extension: { strength: STRENGTH, client: o.kind.startsWith('Prisma') ? 'prisma' : 'pg' },
    });
  }

  // ---- The total, per platform ----

  const configLimit = database?.maxConnections ? { limit: database.maxConnections - PG_RESERVED, maxConnections: database.maxConnections, reserved: PG_RESERVED, why: `max_connections ${database.maxConnections} in erlang.config.json, less ${PG_RESERVED} reserved for superusers`, config: true } : null;
  const closureCache = new Map();
  const kept = owners.filter((o) => o.life !== 'request');
  const stats = { files: files.size, handlers: H.handlers.length, pools: made.length, perRequest: owners.length - kept.length, platforms: [], notes: [...H.notes, ...notes] };

  for (const pf of platforms) {
    const db = configLimit ?? pf.database;
    const procs = [];
    for (const p of pf.processes) {
      const entries = p.entries === 'handlers' ? [...new Set(H.handlers.map((h) => h.file))] : p.entries;
      const reach = entries ? closure(entries) : null;
      const pools = reach ? uniquePools(kept.filter((o) => reach.files.has(o.file))) : null;
      let count = p.count, countWhy = p.countWhy;
      if (reach?.cluster && count !== null) { count = null; countWhy += `; ${reach.cluster} forks workers with node:cluster, how many is not read`; }
      procs.push({ ...p, count, countWhy, pools });
    }
    const withPools = procs.filter((p) => p.pools?.length);
    const unknownEntry = procs.filter((p) => !p.pools);
    stats.platforms.push({ platform: pf.platform, file: pf.file, processes: procs.map((p) => ({ label: p.label, count: p.count, pools: p.pools?.map((x) => x.max) ?? null })), limit: db?.limit ?? null });
    if (!withPools.length) continue;

    // Each pool's processes, and the floor of the total.
    const per = new Map();
    for (const p of withPools) for (const s of p.pools) {
      if (!per.has(s.at)) per.set(s.at, { size: s, count: 0 });
      const e = per.get(s.at);
      e.count += p.count ?? p.floor ?? 1;
    }
    const floor = [...per.values()].reduce((t, e) => t + e.count * (e.size.max ?? 1), 0);
    const unknowns = [
      ...[...per.values()].filter((e) => e.size.max === null).map((e) => `${nameOf(e.size.at)}: ${e.size.why}`),
      ...unknownEntry.map((p) => `${p.label}: ${p.entryWhy}`),
    ];
    const breakdown = withPools.map((p) => `${p.label}, ${p.count ?? `at least ${p.floor ?? 1}`} process${p.count === 1 ? '' : 'es'} (${p.countWhy}), each with ${p.pools.map((s) => `${nameOf(s.at)} ${s.max ?? '?'}`).join(' + ')}`).join('; ');
    const biggest = [...per.values()].sort((a, b) => b.count * (b.size.max ?? 1) - a.count * (a.size.max ?? 1))[0];
    const loc = locationOf(biggest.size.at.node);
    const serverless = withPools.some((p) => p.unbounded);

    if (db?.limit != null && floor > db.limit && !serverless) {
      const others = floor - biggest.count * (biggest.size.max ?? 1);
      const target = Math.floor((db.limit - others) / biggest.count);
      const exact = !unknowns.length && withPools.every((p) => p.count !== null) && biggest.size.max !== null;
      const edit = exact && target >= 1 ? maxEdit(biggest.size, target) : null;
      const total = unknowns.length || withPools.some((p) => p.count === null) ? `at least ${floor}` : `${floor}`;
      const message = `The processes in ${pf.file} can open ${total} connections to PostgreSQL, which accepts ${db.limit} (${db.why}): ${breakdown}. When the pools fill, at peak, new connections are refused ("too many clients already") and requests fail instead of waiting.${unknowns.length ? ` Also unknown, counted as 1: ${unknowns.join('; ')}.` : ''}`;
      const fix = edit
        ? { kind: 'auto', edits: [edit], note: `max ${target} on ${nameOf(biggest.size.at)} brings the total to ${others + target * biggest.count} of ${db.limit}. A rolling deploy runs extra processes for a while: leave room for them, or put a pooler such as PgBouncer in front.` }
        : { kind: 'guided', locations: [{ file: loc.file, line: loc.line }], note: `${target >= 1 ? `At the least counts, max ${target} on ${nameOf(biggest.size.at)} would fit, but the unknown counts can be higher. ` : `The other pools alone use ${others}. `}Lower max on the pools, run fewer processes, or put a pooler such as PgBouncer in front so the processes share fewer database connections; leave room for the extra processes of a rolling deploy.` };
      findings.push({ severity: 'error', message, locations: [loc], fix, keyParts: [key(loc), pf.platform, 'over-limit'], extension: { strength: STRENGTH, client: biggest.size.at.kind.startsWith('Prisma') ? 'prisma' : 'pg', connections: floor, limit: db.limit, ...(unknowns.length ? { unresolved: true } : {}) } });
      continue;
    }
    if (db?.limit != null && !unknowns.length && withPools.every((p) => p.count !== null) && !serverless) continue; // fits
    const why = serverless ? `on ${pf.file}, each concurrent invocation can run its own instance, so ${floor} connection(s) per instance has no ceiling; size it at 1 to 2 and put a pooler in front (PgBouncer, or the platform's)`
      : db?.pooler ? `${db.why}, so the database's own limit is not what these pools meet; compare ${floor} with the pooler's client limit`
      : db?.limit == null ? `the database's max_connections is not in the repository; name it in erlang.config.json as database.maxConnections${db?.why ? ` (${db.why})` : ''}`
      : `unknown: ${[...withPools.filter((p) => p.count === null).map((p) => `${p.label}, ${p.countWhy}`), ...unknowns].join('; ')}`;
    findings.push({
      severity: 'info',
      message: `The processes in ${pf.file} can open ${unknowns.length ? 'at least ' : ''}${floor} connections to PostgreSQL (${breakdown}). Whether the database accepts them is unknown: ${why}.`,
      locations: [loc],
      fix: { kind: 'guided', locations: [{ file: loc.file, line: loc.line }], note: 'Keep pool max × processes, for every process at once, under the database\'s max_connections less its reserved connections, with room for deploys.' },
      keyParts: [key(loc), pf.platform, 'unknown'],
      extension: { strength: STRENGTH, client: biggest.size.at.kind.startsWith('Prisma') ? 'prisma' : 'pg', connections: floor, unresolved: true, ...(db?.limit != null ? { limit: db.limit } : {}) },
    });
  }

  // ---- Helpers ----

  // Files a process loads from its entries, by relative import, require
  // and import(); and whether it forks with node:cluster.
  function closure(entries) {
    const k = entries.join('\n');
    if (closureCache.has(k)) return closureCache.get(k);
    const seen = new Set();
    let cluster = null;
    const queue = [...entries];
    while (queue.length) {
      const rel = queue.shift();
      if (seen.has(rel) || !files.has(rel)) continue;
      seen.add(rel);
      const sf = cx.sourceFile(rel);
      const visit = (n) => {
        let spec = null;
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) spec = n.moduleSpecifier.text;
        else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) spec = n.arguments[0].text;
        if (spec === 'cluster' || spec === 'node:cluster') cluster ??= rel;
        if (spec) { const r = resolveSpec(rel, spec); if (r) queue.push(r); }
        ts.forEachChild(n, visit);
      };
      if (sf) visit(sf);
    }
    const out = { files: seen, cluster };
    closureCache.set(k, out);
    return out;
  }
  function resolveSpec(from, spec) {
    let base;
    if (spec.startsWith('.')) base = posixJoin(dirOf(from), spec);
    else if (/^[@~]\//.test(spec)) base = spec.slice(2);
    else return null;
    const stems = [base, base.replace(/\.[cm]?js$/, ''), base.replace(/\.jsx?$/, '')];
    for (const s of [...stems, ...stems.map((x) => `src/${x}`)]) {
      for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.js']) if (files.has(s + ext)) return s + ext;
    }
    return null;
  }
  function dirOf(rel) { return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''; }
  function posixJoin(dir, spec) {
    const parts = dir ? dir.split('/') : [];
    for (const p of spec.split('/')) { if (p === '..') parts.pop(); else if (p !== '.' && p !== '') parts.push(p); }
    return parts.join('/');
  }
  // One entry per pool, however many owners share it.
  function uniquePools(list) {
    const out = new Map();
    for (const o of list) if (!out.has(o.size.at)) out.set(o.size.at, o.size);
    return [...out.values()];
  }
  function maxEdit(size, n) {
    const file = size.at.file;
    if (size.value) return size.literal ? replaceNode(file, unwrap(size.value), String(n)) : null;
    return size.options ? insertProperty(file, size.options, `max: ${n}`) : null;
  }
  function nameOf(m) { return symbolAt(m.node) ?? `the ${m.kind} in ${m.file}`; }
  function enclosingText(node) { for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n.getText(); return node.getSourceFile().text; }
  function fileOf(node) { return relOf(node.getSourceFile().fileName); }
  function locationOf(node) {
    const p = position(node);
    const symbol = symbolAt(node);
    return { file: fileOf(node), line: p.line, column: p.column, ...(symbol ? { symbol } : {}) };
  }
  function key(l) { return `${l.file}#${l.symbol ?? '<module>'}`; }

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
      where: { locations: f.locations },
      extension: { ...f.extension, fix: f.fix },
    });
  });
  return { findings: out, run: stats, incomplete: gaps };
}
