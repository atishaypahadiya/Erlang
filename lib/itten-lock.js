// ITTEN's timing lock, which ERLANG honours (the owner's rule, shared with
// ITTEN). ERLANG takes no lock of its own and never writes or deletes in the
// lock directory.
//
// Location: timing-<pid>.json in the first of $ITTEN_LOCK_DIR,
// $XDG_STATE_HOME/itten/locks and $HOME/.local/state/itten/locks that is set.
// Only names matching timing-<digits>.json are locks; a missing directory
// means no locks.
// Contents: { format: "itten-timing-lock/1", pid, phase ("benchmark" or
// "motion"), taken, expires (ISO 8601 UTC), project }.
// Active: the file parses, the format matches, the pid is alive and now is
// before expires. A file that cannot be read or parsed is active too, and so
// is one in a format ERLANG does not know (docs/decisions.md, Q5).
// Stale: the pid is dead, or now is at or past expires. A stale lock is
// ignored and left in place.
// While any lock is active, ERLANG generates no load: it rereads about once
// a second, up to a limit, then stops with exit 75 naming the lock, and it
// rereads immediately before starting load.

import { readdirSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';

export const FORMAT = 'itten-timing-lock/1';
export const EXIT_LOCKED = 75;
const NAME = /^timing-\d+\.json$/;

// The lock directory: the first of the three that is set.
export function lockDir(env = process.env) {
  if (env.ITTEN_LOCK_DIR) return env.ITTEN_LOCK_DIR;
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, 'itten', 'locks');
  if (env.HOME) return join(env.HOME, '.local', 'state', 'itten', 'locks');
  return null;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// One lock file's state: active or stale. A lock in a format ERLANG does not
// know counts as active, as one it cannot parse does (the owner, 19 November
// 2026, docs/decisions.md Q5): a newer ITTEN is not timed under load while ERLANG
// learns its format. It is stale only when its pid is dead or its expiry
// past, read as this format reads them.
export function judgeLock(file, text, now = Date.now(), isAlive = alive) {
  let lock;
  try { lock = JSON.parse(text); } catch { return { file, state: 'active', why: 'cannot be parsed' }; }
  if (!lock || typeof lock !== 'object') return { file, state: 'active', why: 'cannot be parsed' };
  const expires = Date.parse(lock.expires);
  const pid = Number(lock.pid);
  if ((Number.isInteger(pid) && pid > 0 && !isAlive(pid)) || (Number.isFinite(expires) && now >= expires)) return { file, state: 'stale', lock };
  if (lock.format !== FORMAT) return { file, state: 'active', lock, why: `format ${JSON.stringify(lock.format)}, not ${FORMAT}: a format ERLANG does not know counts as active` };
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(expires)) return { file, state: 'active', lock, why: 'its pid or expiry cannot be read' };
  return { file, state: 'active', lock };
}

// Every lock in the directory, judged.
export function locks({ env = process.env, now = Date.now(), isAlive = alive } = {}) {
  const dir = lockDir(env);
  if (!dir || !existsSync(dir)) return [];
  let names;
  try { names = readdirSync(dir); } catch { return [{ file: dir, state: 'active', why: 'the lock directory cannot be read' }]; }
  return names.filter((n) => NAME.test(n)).sort().map((n) => {
    const file = join(dir, n);
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { return { file, state: 'active', why: 'cannot be read' }; }
    return judgeLock(file, text, now, isAlive);
  });
}

// A running Lima VM counts as an active lock (the owner, 20 November 2026):
// a benchmark harness on the same Mac runs 2-CPU VMs from time to time, and
// nothing timed starts while one runs. From `limactl list`, reread at most
// every 5 s; where limactl is absent (CI), none. Read only for the real
// environment: a caller that passes its own env (the unit tests) sees no VMs
// unless it passes vms.
let vmCache = { at: 0, list: [] };
export function runningVms(now = Date.now()) {
  if (now - vmCache.at < 5000) return vmCache.list;
  const r = spawnSync('limactl', ['list', '--format', '{{.Name}}\t{{.Status}}'], { encoding: 'utf8', timeout: 10_000 });
  const list = r.status === 0 ? r.stdout.split('\n').map((l) => l.split('\t')).filter(([name, status]) => name && status === 'Running').map(([name]) => name) : [];
  vmCache = { at: now, list };
  return list;
}
const vmLock = (name) => ({ file: `limactl: ${name}`, state: 'active', vm: name, why: 'a Lima VM is running' });
export const active = (opts = {}) => [
  ...locks(opts).filter((l) => l.state === 'active'),
  ...(opts.vms ?? (opts.env && opts.env !== process.env ? () => [] : runningVms))().map(vmLock),
];

// A lock, named for a person: its file, phase, project, pid and expiry.
export function describe(l) {
  if (l.vm) return `Lima VM ${l.vm} is running (limactl list)`;
  if (!l.lock) return `${l.file} (${l.why})`;
  const { phase, project, pid, expires } = l.lock;
  return `${l.file}: ITTEN ${phase ?? 'timing'} run${project ? ` of ${project}` : ''}, pid ${pid}, until ${expires}${l.why ? ` (${l.why})` : ''}`;
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// The wait log. Every wait names the lock's phase, taken and expires when it
// starts and whenever the lock waited on changes, and says how long it
// lasted when it ends, with the total this process has waited. One line per
// finished wait is appended to the log file (JSON lines, in dist/), so the
// longest continuous wait and the phase that held it can be read afterwards.
// A continuous wait is one call that waited: from the first active lock seen
// to the reread that found none (or the limit); its segments are the locks
// held in turn, each with its own phase.
let waitedMs = 0;
export const totalWaitedMs = () => waitedMs;
const phaseOf = (l) => (l.vm ? `Lima VM ${l.vm}` : l.lock?.phase ?? `unknown (${l.why ?? 'no phase'})`);
const lockLine = (l) => `phase ${phaseOf(l)}, taken ${l.lock?.taken ?? '?'}, expires ${l.lock?.expires ?? '?'}${l.lock?.project ? `, project ${l.lock.project}` : ''}`;
function record(entry, logFile) {
  if (!logFile) return;
  try { mkdirSync(dirname(logFile), { recursive: true }); appendFileSync(logFile, JSON.stringify(entry) + '\n'); } catch { /* the log is a record, never a reason to stop */ }
}

// Waits while any lock is active, rereading about once a second, for at most
// limitMs. Returns null when none is active (just reread), or the lock still
// active when the limit is reached. log: where wait lines go (stderr by
// default); logFile: the JSON-lines record (ERLANG_LOCK_WAIT_LOG, else none).
export async function waitForNoLock({ limitMs = 600_000, onWait = () => {}, log = (line) => process.stderr.write(line + '\n'), logFile = process.env.ERLANG_LOCK_WAIT_LOG ?? null, label = 'erlang', ...opts } = {}) {
  const until = Date.now() + limitMs;
  let told = null;
  let started = null;
  const segments = [];
  const finish = (outcome) => {
    if (started === null) return;
    const now = Date.now();
    segments.at(-1).endedAt = new Date(now).toISOString();
    const ms = now - started;
    waitedMs += ms;
    log(`lock-wait: ${label}: waited ${(ms / 1000).toFixed(1)} s (${segments.map((x) => `${x.phase} until ${x.expires ?? '?'}`).join(', then ')}), ${outcome}; total waited by this process ${(waitedMs / 1000).toFixed(1)} s`);
    record({ label, pid: process.pid, startedAt: new Date(started).toISOString(), endedAt: new Date(now).toISOString(), ms, outcome, segments }, logFile);
  };
  for (;;) {
    const a = active(opts);
    if (!a.length) { finish('lock gone'); return null; }
    if (Date.now() >= until) { finish('limit reached'); return a[0]; }
    // Told again whenever the lock waited on changes (another ITTEN run).
    if (told !== a[0].file) {
      const now = Date.now();
      if (started === null) started = now;
      else segments.at(-1).endedAt = new Date(now).toISOString();
      segments.push({ file: a[0].file, phase: phaseOf(a[0]), taken: a[0].lock?.taken ?? null, expires: a[0].lock?.expires ?? null, startedAt: new Date(now).toISOString() });
      log(`lock-wait: ${label}: waiting on ${a[0].vm ? `a running Lima VM, ${a[0].vm} (limactl list)` : `ITTEN's lock: ${lockLine(a[0])} (${a[0].file})`}`);
      onWait(a[0]);
      told = a[0].file;
    }
    await sleep(1000);
  }
}
