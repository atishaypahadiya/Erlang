// Waits while an ITTEN timing lock is active (lib/itten-lock.js), for at
// most ERLANG_LOCK_WAIT_S seconds (600 by default), rereading about once a
// second. Exit 0 when no lock is active; 75 naming the lock otherwise.
// Reads the lock directory only; never writes or deletes in it.
//
// Usage: node scripts/itten-lock.js <what is about to start>

import { waitForNoLock, describe, EXIT_LOCKED } from '../lib/itten-lock.js';
import { exitOnCrash } from '../lib/crash.js';

exitOnCrash('itten-lock');

const what = process.argv[2] ?? 'load';
const limitMs = 1000 * Number(process.env.ERLANG_LOCK_WAIT_S ?? 600);
const held = await waitForNoLock({ label: `${what} start`, limitMs, onWait: (l) => console.error(`${what}: waiting for ITTEN's timing lock: ${describe(l)}`) });
if (held) {
  console.error(`${what}: ITTEN's timing lock is still active after ${limitMs / 1000} s; not starting. ${describe(held)}`);
  process.exit(EXIT_LOCKED);
}
