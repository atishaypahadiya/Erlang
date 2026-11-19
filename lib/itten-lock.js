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
// before expires. A file that cannot be read or parsed is active too.
// Stale: the pid is dead, or now is at or past expires. A stale lock is
// ignored and left in place.
// While any lock is active, ERLANG generates no load: it rereads about once
// a second, up to a limit, then stops with exit 75 naming the lock, and it
// rereads immediately before starting load.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

// One lock file's state: active, stale, or neither (a lock in another
// format, which the rule does not make active).
export function judgeLock(file, text, now = Date.now(), isAlive = alive) {
  let lock;
  try { lock = JSON.parse(text); } catch { return { file, state: 'active', why: 'cannot be parsed' }; }
  if (!lock || typeof lock !== 'object') return { file, state: 'active', why: 'cannot be parsed' };
  const expires = Date.parse(lock.expires);
  const pid = Number(lock.pid);
  if ((Number.isInteger(pid) && pid > 0 && !isAlive(pid)) || (Number.isFinite(expires) && now >= expires)) return { file, state: 'stale', lock };
  if (lock.format !== FORMAT) return { file, state: 'other', lock, why: `format ${JSON.stringify(lock.format)}, not ${FORMAT}` };
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

export const active = (opts) => locks(opts).filter((l) => l.state === 'active');

// A lock, named for a person: its file, phase, project, pid and expiry.
export function describe(l) {
  if (!l.lock) return `${l.file} (${l.why})`;
  const { phase, project, pid, expires } = l.lock;
  return `${l.file}: ITTEN ${phase ?? 'timing'} run${project ? ` of ${project}` : ''}, pid ${pid}, until ${expires}${l.why ? ` (${l.why})` : ''}`;
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Waits while any lock is active, rereading about once a second, for at most
// limitMs. Returns null when none is active (just reread), or the lock still
// active when the limit is reached.
export async function waitForNoLock({ limitMs = 600_000, onWait = () => {}, ...opts } = {}) {
  const until = Date.now() + limitMs;
  let told = false;
  for (;;) {
    const a = active(opts);
    if (!a.length) return null;
    if (Date.now() >= until) return a[0];
    if (!told) { onWait(a[0]); told = true; }
    await sleep(1000);
  }
}
