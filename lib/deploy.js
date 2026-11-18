// What a project deploys, read from its deployment files: which processes run,
// how many of each, which source file each starts from, and the database
// they share. Static: reads files, runs nothing.
//
// Platforms read:
//   compose     docker-compose.yml / compose.yml at the scan root: services
//               with build: (or a command naming a project file), deploy.
//               replicas or scale; a postgres service's max_connections.
//   kubernetes  manifests anywhere in scope: Deployment and StatefulSet
//               replicas (an HPA's maxReplicas when one targets it), Job and
//               CronJob parallelism; DaemonSet counts are unknown.
//   fly         fly.toml: its machine count is not in the file, so unknown.
//   serverless  vercel.json, netlify.toml, serverless.yml: unbounded.
// Inside a process: PM2 (an ecosystem file or pm2 start -i N), npm/yarn/pnpm
// scripts, the Dockerfile's CMD and ENTRYPOINT, next start. A count ERLANG
// cannot read is null with the reason, never a guess.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { ts } from './program.js';
import { unwrap } from './resolve.js';
import { OUTPUT_DIRS } from './sources.js';
import { excluded } from './scope.js';
import { perFile, decode } from './isolate.js';
import { parseYaml } from './yaml.js';

export const PG_DEFAULT_LIMIT = 100;
export const PG_RESERVED = 3;
const COMPOSE = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const SERVERLESS = ['vercel.json', 'netlify.toml', 'serverless.yml', 'serverless.yaml'];
// Images that are not the project's code: a container running one without a
// command is not one of its processes.
const INFRA = /(^|\/)(postgres|postgresql|pgbouncer|redis|valkey|mysql|mariadb|mongo|nginx|traefik|caddy|rabbitmq|memcached|elasticsearch|opensearch|kafka|zookeeper|minio|grafana|prometheus|jaeger|otel)[\w.-]*(:|@|$)/i;
const POSTGRES = /(^|\/)(postgres|postgresql)(:|@|$)/i;
const POOLER = /pgbouncer|pgcat|odyssey|supavisor|pgpool/i;
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const MAX_HOPS = 4;

// { platforms: [{ platform, file, processes, database }], notes }
// processes: [{ label, file, line, count, countWhy, unbounded?, entries,
//               entryWhy }]; entries is a list of source paths or null.
// database: { limit, reserved, why, file?, line?, pooler? } or null.
export function deployments(root, cx, files, gaps) {
  const notes = [];
  const platforms = [];
  const read = (rel) => { try { return decode(readFileSync(join(root, rel))); } catch { return null; } };
  const dockerfiles = new Map();
  const dockerCmd = (dir) => {
    const rel = dir ? `${dir}/Dockerfile` : 'Dockerfile';
    if (!dockerfiles.has(rel)) dockerfiles.set(rel, perFile(gaps, rel, () => readDockerfile(read(rel)), null));
    return dockerfiles.get(rel);
  };
  const resolver = entryResolver(cx, files, root, read, dockerCmd);

  // ---- Compose ----
  for (const name of COMPOSE) {
    if (!existsSync(join(root, name)) || excluded(join(root, name))) continue;
    perFile(gaps, name, () => {
      const [doc] = parseYaml(read(name) ?? '');
      const services = doc?.services;
      if (!services || typeof services !== 'object') return;
      const processes = [];
      const dbs = [];
      let pooler = null;
      for (const [svc, s] of Object.entries(services)) {
        if (!s || typeof s !== 'object') continue;
        const line = services.$lines[svc];
        const image = typeof s.image === 'string' ? s.image : '';
        if (POOLER.test(image) || POOLER.test(svc)) { pooler = svc; continue; }
        if (POSTGRES.test(image)) { dbs.push({ svc, s, line }); continue; }
        const context = typeof s.build === 'string' ? s.build : s.build?.context ?? null;
        const dir = context === null ? null : posix.normalize(context).replace(/^\.\/?|\/$/g, '').replace(/^\.$/, '');
        const command = s.command ?? s.entrypoint ?? null;
        let r;
        if (command !== null) r = resolver(command, dir ?? '');
        else if (context !== null) r = resolver(dockerCmd(dir), dir, 'the Dockerfile');
        else continue;
        if (context === null && !r.entries) continue; // an image ERLANG cannot see into
        let count = 1, countWhy = 'one replica (no deploy.replicas)';
        const replicas = s.deploy?.replicas ?? s.scale;
        if (s.deploy?.mode === 'global') { count = null; countWhy = 'deploy.mode global: one per node'; }
        else if (replicas !== undefined) {
          if (Number.isInteger(replicas) && replicas >= 0) { count = replicas; countWhy = `${s.deploy?.replicas !== undefined ? 'deploy.replicas' : 'scale'} ${replicas}`; }
          else { count = null; countWhy = `replicas ${JSON.stringify(replicas)}, not a number ERLANG can read`; }
        }
        for (const p of r.processes) processes.push({ label: p.label ? `${svc} (${p.label})` : svc, file: name, line, count: mul(count, p.per), floor: atLeast(count, p.per), countWhy: [countWhy, ...p.perWhy].join(' × '), entries: p.entries, entryWhy: p.why });
      }
      let database = null;
      if (pooler) database = { limit: null, pooler, why: `the ${pooler} service pools connections in front of the database`, file: name, line: services.$lines[pooler] };
      else if (dbs.length === 1) database = postgresLimit(dbs[0], name);
      else if (dbs.length > 1) database = { limit: null, why: `${dbs.length} PostgreSQL services; which one each pool uses is not read` };
      platforms.push({ platform: 'compose', file: name, processes, database });
    });
  }

  // ---- Kubernetes ----
  const workloads = [];
  const hpas = [];
  const k8sDb = [];
  let k8sPooler = null;
  const yamls = [];
  walk('', (rel) => /\.ya?ml$/.test(rel) && !COMPOSE.includes(rel) && !SERVERLESS.includes(rel), yamls);
  for (const rel of yamls) {
    perFile(gaps, rel, () => {
      const text = read(rel);
      if (!text || !/^kind:/m.test(text)) return;
      for (const doc of parseYaml(text)) {
        if (!doc || typeof doc !== 'object' || typeof doc.kind !== 'string') continue;
        if (doc.kind === 'HorizontalPodAutoscaler') hpas.push({ doc, file: rel });
        else if (['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'].includes(doc.kind)) workloads.push({ doc, file: rel });
      }
    });
  }
  if (workloads.length) {
    const processes = [];
    for (const { doc, file } of workloads) {
      const name = doc.metadata?.name ?? doc.kind;
      const spec = doc.kind === 'CronJob' ? doc.spec?.jobTemplate?.spec : doc.spec;
      const pod = spec?.template?.spec;
      const line = doc.$lines.kind;
      let count, countWhy;
      if (doc.kind === 'DaemonSet') { count = null; countWhy = 'a DaemonSet: one per node'; }
      else if (doc.kind === 'Job' || doc.kind === 'CronJob') {
        const par = spec?.parallelism ?? 1;
        count = Number.isInteger(par) ? par : null;
        countWhy = `${doc.kind}, parallelism ${par}`;
      } else {
        const hpa = hpas.find((h) => h.doc.spec?.scaleTargetRef?.name === name && (h.doc.spec.scaleTargetRef.kind ?? doc.kind) === doc.kind);
        const raw = hpa ? hpa.doc.spec.maxReplicas : doc.spec?.replicas ?? 1;
        count = Number.isInteger(raw) ? raw : null;
        countWhy = hpa ? `the HorizontalPodAutoscaler's maxReplicas ${raw} (${hpa.file})` : doc.spec?.replicas === undefined ? 'replicas 1 (not set)' : `replicas ${raw}`;
        if (count === null) countWhy += ', not a number ERLANG can read';
      }
      for (const c of pod?.containers ?? []) {
        if (!c || typeof c !== 'object') continue;
        const image = typeof c.image === 'string' ? c.image : '';
        if (POOLER.test(image)) { k8sPooler = name; continue; }
        if (POSTGRES.test(image)) { k8sDb.push({ svc: name, s: { command: [...(c.command ?? []), ...(c.args ?? [])], environment: envOf(c.env) }, line, file }); continue; }
        let r;
        if (c.command || c.args) r = resolver([...(Array.isArray(c.command) ? c.command : c.command ? [c.command] : []), ...(Array.isArray(c.args) ? c.args : c.args ? [c.args] : [])], '');
        else if (!INFRA.test(image) && existsSync(join(root, 'Dockerfile'))) r = resolver(dockerCmd(''), '', 'the Dockerfile');
        else continue;
        if (!r.entries && INFRA.test(image)) continue;
        for (const p of r.processes) processes.push({ label: `${name}${(pod.containers.length > 1) ? `/${c.name}` : ''}${p.label ? ` (${p.label})` : ''}`, file, line, count: mul(count, p.per), floor: atLeast(count, p.per), countWhy: [countWhy, ...p.perWhy].join(' × '), entries: p.entries, entryWhy: p.why });
      }
    }
    let database = null;
    if (k8sPooler) database = { limit: null, pooler: k8sPooler, why: `${k8sPooler} pools connections in front of the database` };
    else if (k8sDb.length === 1) database = postgresLimit(k8sDb[0], k8sDb[0].file);
    else if (k8sDb.length > 1) database = { limit: null, why: `${k8sDb.length} PostgreSQL workloads; which one each pool uses is not read` };
    platforms.push({ platform: 'kubernetes', file: [...new Set(workloads.map((w) => w.file))].join(', '), processes, database });
  }

  // ---- Fly ----
  if (existsSync(join(root, 'fly.toml')) && !excluded(join(root, 'fly.toml'))) {
    perFile(gaps, 'fly.toml', () => {
      const text = read('fly.toml') ?? '';
      const procs = [];
      const sec = text.match(/^\[processes\]\s*\n((?:(?!\[)[^\n]*\n?)*)/m);
      if (sec) for (const m of sec[1].matchAll(/^\s*([\w-]+)\s*=\s*["']([^"']+)["']/gm)) procs.push([m[1], m[2]]);
      const runs = procs.length ? procs.map(([n, cmd]) => [n, resolver(cmd, '')]) : [['app', resolver(dockerCmd(''), '', 'the Dockerfile')]];
      const processes = runs.flatMap(([n, r]) => r.processes.map((p) => ({ label: p.label ? `${n} (${p.label})` : n, file: 'fly.toml', line: 1, count: null, countWhy: 'the machine count is set by fly scale, not in fly.toml', entries: p.entries, entryWhy: p.why })));
      platforms.push({ platform: 'fly', file: 'fly.toml', processes, database: null });
    });
  }

  // ---- Serverless ----
  const sls = SERVERLESS.find((f) => existsSync(join(root, f)) && !excluded(join(root, f)));
  if (sls) platforms.push({ platform: 'serverless', file: sls, processes: [{ label: 'functions', file: sls, line: 1, count: null, unbounded: true, countWhy: 'each concurrent invocation can run in its own instance', entries: 'handlers', entryWhy: 'every request handler' }], database: null });

  if (!platforms.length) notes.push('no deployment file found (docker-compose.yml, Kubernetes manifests, fly.toml, a serverless config), so how many processes run is unknown');
  return { platforms, notes };

  function walk(dir, want, out) {
    let entries;
    try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = dir ? `${dir}/${e.name}` : e.name;
      if (e.isSymbolicLink() || excluded(join(root, r))) continue;
      if (e.isDirectory()) { if (!OUTPUT_DIRS.has(e.name) && !e.name.startsWith('.')) walk(r, want, out); continue; }
      if (e.isFile() && want(r)) out.push(r);
    }
    out.sort();
  }
}

const mul = (a, b) => (a === null || b === null ? null : a * b);
// The least a count can be: unknown factors are at least 1.
const atLeast = (a, b) => (a ?? 1) * (b ?? 1);

function envOf(env) {
  const out = {};
  if (Array.isArray(env)) for (const e of env) if (e && typeof e === 'object' && e.name) out[e.name] = e.value;
  return out;
}

// A PostgreSQL service's usable connections: max_connections (from -c
// max_connections=N, POSTGRESQL_MAX_CONNECTIONS, or the default 100) less
// superuser_reserved_connections (default 3).
function postgresLimit({ svc, s, line }, file) {
  const cmd = Array.isArray(s.command) ? s.command.join(' ') : String(s.command ?? '');
  const env = s.environment && typeof s.environment === 'object' && !Array.isArray(s.environment) ? s.environment
    : Object.fromEntries((Array.isArray(s.environment) ? s.environment : []).map((x) => String(x).split('=')));
  const set = (key, envKey) => {
    const m = cmd.match(new RegExp(`${key}\\s*=\\s*(\\S+)`));
    const v = m ? m[1] : env[envKey];
    return v === undefined ? undefined : Number(v);
  };
  const max = set('max_connections', 'POSTGRESQL_MAX_CONNECTIONS');
  const reserved = set('superuser_reserved_connections', 'POSTGRESQL_SUPERUSER_RESERVED_CONNECTIONS') ?? PG_RESERVED;
  if (max !== undefined && !Number.isInteger(max)) return { limit: null, why: `the ${svc} service's max_connections is not a number ERLANG can read`, file, line };
  const n = max ?? PG_DEFAULT_LIMIT;
  return { limit: n - reserved, maxConnections: n, reserved, why: `max_connections ${n}${max === undefined ? ', PostgreSQL\'s default' : ''} on the ${svc} service, less ${reserved} reserved for superusers`, file, line };
}

// The Dockerfile's command, as a list of words: ENTRYPOINT then CMD, of the
// last stage. null when there is none.
function readDockerfile(text) {
  if (text === null) return null;
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  let entry = null, cmd = null;
  const words = (rest) => { rest = rest.trim(); if (rest.startsWith('[')) { try { return JSON.parse(rest); } catch { return null; } } return ['sh', '-c', rest]; };
  for (const l of lines) {
    const m = l.match(/^\s*(FROM|CMD|ENTRYPOINT)\s+(.*)$/i);
    if (!m) continue;
    const k = m[1].toUpperCase();
    if (k === 'FROM') { entry = null; cmd = null; }
    else if (k === 'CMD') cmd = words(m[2]);
    else entry = words(m[2]);
  }
  // A shell-form ENTRYPOINT ignores CMD; an exec-form one takes it as arguments.
  const all = entry ? (entry[0] === 'sh' ? entry : [...entry, ...(cmd ?? [])]) : cmd ?? [];
  return all.length ? all : null;
}

// From a command to the processes it starts: [{ label, per, perWhy,
// entries, why }]. per is how many processes one container runs (PM2
// instances), entries the source files they start from (null: unknown).
function entryResolver(cx, files, root, read, dockerCmd) {
  const pkgOf = (dir) => { try { return JSON.parse(read(dir ? `${dir}/package.json` : 'package.json') ?? 'null'); } catch { return null; } };
  const has = (rel) => files.has(rel);
  const fileIn = (dir, p) => { const r = posix.normalize(dir ? `${dir}/${p}` : p).replace(/^\.\//, ''); return has(r) ? r : null; };

  const resolve = (command, dir, from = null, hops = 0) => {
    const unknown = (why) => ({ processes: [{ label: null, per: 1, perWhy: [], entries: null, why }], entries: null });
    if (command === null || command === undefined) return unknown(`${from ?? 'the service'} names no command`);
    let words = Array.isArray(command) ? command.map(String) : String(command).trim().split(/\s+/);
    if (['sh', '/bin/sh', 'bash', '/bin/bash'].includes(words[0]) && words[1] === '-c') words = words.slice(2).join(' ').split(/\s+/);
    // The last command of a chain is the one that stays up.
    const text = words.join(' ');
    const segs = text.split(/\s*(?:&&|;|\|\|)\s*/).filter(Boolean);
    words = (segs.at(-1) ?? '').split(/\s+/);
    while (words.length && (/^\w+=/.test(words[0]) || ['exec', 'npx', 'dumb-init', 'tini', '--'].includes(words[0]))) words.shift();
    const [cmd, ...args] = words;
    const shown = text.length > 60 ? `${text.slice(0, 57)}...` : text;
    if (!cmd) return unknown(`${from ?? 'the command'} is empty`);
    if (hops > MAX_HOPS) return unknown(`${shown}: too many hops to follow`);
    const nonFlag = (xs) => xs.filter((x) => !x.startsWith('-'));
    if (/^(npm|yarn|pnpm|bun)$/.test(cmd)) {
      const script = args[0] === 'run' || args[0] === 'run-script' ? args[1] : args[0] === 'start' ? 'start' : cmd !== 'npm' ? args[0] : null;
      const pkg = pkgOf(dir);
      const body = script && pkg?.scripts?.[script];
      if (!body) return unknown(`${shown}: no ${script ?? 'such'} script in package.json`);
      return resolve(body, dir, `the ${script} script`, hops + 1);
    }
    if (cmd === 'pm2-runtime' || cmd === 'pm2' || cmd.endsWith('/pm2-runtime')) {
      const rest = cmd === 'pm2' ? args.slice(args.indexOf('start') + 1) : args;
      const target = nonFlag(rest).find((x) => !/^\d+$/.test(x));
      const iFlag = rest.findIndex((x) => x === '-i' || x === '--instances');
      if (target && /ecosystem|\.config\.|\.json$/.test(target)) return pm2(target, dir, hops);
      const per = iFlag >= 0 ? instancesOf(rest[iFlag + 1]) : { n: 1, why: 'one PM2 process' };
      const file = target && fileIn(dir, target);
      return { processes: [{ label: null, per: per.n, perWhy: iFlag >= 0 ? [per.why] : [], entries: file ? [file] : null, why: file ? `pm2 starts ${file}` : `${shown}: the script is not a project file` }], entries: file ? [file] : null };
    }
    if (cmd === 'next' && args[0] === 'start') {
      const entries = [...files.keys()].filter((r) => /^(src\/)?(app|pages)\//.test(r) || /^(src\/)?middleware\.[jt]s$/.test(r));
      return { processes: [{ label: null, per: 1, perWhy: [], entries, why: 'next start serves every route' }], entries };
    }
    const runners = /^(node|nodejs|tsx|ts-node|ts-node-esm|bun|deno|nodemon)$/;
    const candidates = runners.test(cmd) ? nonFlag(args).filter((x) => x !== 'run') : [cmd, ...args];
    for (const c of candidates) {
      if (!SCRIPT_FILE.test(c)) continue;
      const file = fileIn(dir, c) ?? fileIn(dir, c.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')) ?? fileIn(dir, c.replace(/^(dist|build)\//, 'src/'));
      if (file) return { processes: [{ label: null, per: 1, perWhy: [], entries: [file], why: `${shown} starts ${file}` }], entries: [file] };
    }
    return unknown(`${shown}: not a command ERLANG follows to a project file`);
  };

  // A PM2 ecosystem file: one process kind per app, instances each.
  const pm2 = (target, dir, hops) => {
    const rel = posix.normalize(dir ? `${dir}/${target}` : target).replace(/^\.\//, '');
    let apps = null;
    if (rel.endsWith('.json')) { try { apps = JSON.parse(read(rel) ?? 'null')?.apps ?? null; } catch { apps = null; } }
    else if (has(rel)) apps = ecosystemApps(cx.sourceFile(rel));
    if (!apps) return { processes: [{ label: null, per: null, perWhy: [`PM2 instances in ${rel}, not read`], entries: null, why: `${rel} could not be read` }], entries: null };
    const base = posix.dirname(rel) === '.' ? '' : posix.dirname(rel);
    const processes = apps.map((a) => {
      const file = typeof a.script === 'string' ? fileIn(base, a.script) : null;
      const per = a.instances === undefined ? { n: 1, why: `PM2 ${a.name ?? 'app'}: 1 instance` } : instancesOf(a.instances, a.name);
      return { label: apps.length > 1 ? a.name ?? a.script : null, per: per.n, perWhy: [`${per.why} (${rel})`], entries: file ? [file] : null, why: file ? `PM2 runs ${file}` : `PM2 app ${a.name ?? '?'}: script not a project file` };
    });
    return { processes, entries: processes.flatMap((p) => p.entries ?? []) };
  };
  return resolve;
}

// PM2 instances: a number, or max/0/-1 (one per CPU, unknown here).
function instancesOf(v, name = null) {
  const n = typeof v === 'number' ? v : /^-?\d+$/.test(String(v)) ? Number(v) : NaN;
  const who = name ? `PM2 ${name}` : 'PM2';
  if (Number.isInteger(n) && n > 0) return { n, why: `${who}: ${n} instances` };
  return { n: null, why: `${who}: instances ${v}, one per CPU, and the CPU count is not in the repository` };
}

// apps from module.exports = { apps: [...] } or export default { apps }.
function ecosystemApps(sf) {
  if (!sf) return null;
  let value = null;
  const visit = (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && /^module\.exports$/.test(n.left.getText())) value = n.right;
    if (ts.isExportAssignment(n)) value = n.expression;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  value = unwrap(value);
  if (!value || !ts.isObjectLiteralExpression(value)) return null;
  const apps = value.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'apps');
  const arr = apps && unwrap(apps.initializer);
  if (!arr || !ts.isArrayLiteralExpression(arr)) return null;
  return arr.elements.map((el) => {
    el = unwrap(el);
    const out = {};
    if (!ts.isObjectLiteralExpression(el)) return out;
    for (const p of el.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const v = unwrap(p.initializer);
      const key = p.name.getText().replace(/^['"]|['"]$/g, '');
      if (ts.isStringLiteralLike(v)) out[key] = v.text;
      else if (ts.isNumericLiteral(v)) out[key] = Number(v.text);
      else if (ts.isPrefixUnaryExpression(v) && v.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(v.operand)) out[key] = -Number(v.operand.text);
      else out[key] = v.getText();
    }
    return out;
  });
}
