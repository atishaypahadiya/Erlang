// Declared timers: the delay a wait asked for, not how long it took (L06: a
// fixed wait is judged on the value the code declares, with no clock;
// docs/CONTRACT.md, absolute waits). Every way Node offers to wait on a
// timer is wrapped: the global setTimeout, node:timers' setTimeout, and
// node:timers/promises' setTimeout and scheduler.wait. ESM named imports
// see the wrappers through syncBuiltinESMExports, so install() runs before
// the twin's code is imported. Times are process.hrtime in ms, the clock
// the stub stamps its hits with.
import { syncBuiltinESMExports } from 'node:module';
import timers from 'node:timers';
import timersPromises from 'node:timers/promises';

export const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;

let declared = null;
const note = (delay, via) => { declared?.push({ ms: Number(delay ?? 0), at: nowMs(), via }); };
let installed = false;

export function install() {
  if (installed) return;
  installed = true;
  // Callback timers: the global and node:timers' export are one function.
  const plain = globalThis.setTimeout;
  const wrapped = function setTimeout(fn, delay, ...rest) { note(delay, 'setTimeout'); return plain.call(this, fn, delay, ...rest); };
  for (const k of Reflect.ownKeys(plain)) if (!['length', 'name', 'prototype'].includes(k)) Object.defineProperty(wrapped, k, Object.getOwnPropertyDescriptor(plain, k));
  globalThis.setTimeout = wrapped;
  timers.setTimeout = wrapped;
  // Promise timers.
  const plainP = timersPromises.setTimeout;
  timersPromises.setTimeout = function setTimeout(delay, ...rest) { note(delay ?? 1, 'timers/promises setTimeout'); return plainP.call(this, delay, ...rest); };
  const scheduler = timersPromises.scheduler;
  if (scheduler && typeof scheduler.wait === 'function') {
    const plainWait = scheduler.wait;
    scheduler.wait = function wait(delay, ...rest) { note(delay, 'scheduler.wait'); return plainWait.call(this, delay, ...rest); };
  }
  syncBuiltinESMExports();
}

// Recording runs from start() to take(), which returns what was declared.
export function start() { declared = []; }
export function take() { const list = declared ?? []; declared = null; return list; }
