// One file's failure is that file's, not the scan's (fixtures/PLAN.md, ground
// rules). Every check reads file by file; an error while reading or judging
// one file marks that file unread, which makes the report partial with the
// file and the error named, and the check goes on to the next file.
//
// An error's message can quote what it failed on (a parser quotes the text
// around the fault, fs errors give absolute paths), and a report must never
// carry the owner's code or home directory. So a message is never copied,
// with one exception: a Plain error, whose message ERLANG wrote and which
// never quotes a file. Any other error is described from an allowlist: its
// code or name, the position, line and column numbers in its message, and
// where in ERLANG's own code it was thrown. As in KERCKHOFFS's lib/isolate.js.

import { fileURLToPath } from 'node:url';

// An error whose message is ERLANG's own text, safe to report.
export class Plain extends Error {}

const HOME = fileURLToPath(new URL('..', import.meta.url));

// Where in ERLANG's code an error was thrown, relative to the package, or null.
function thrownIn(e) {
  for (const line of String(e?.stack ?? '').split('\n').slice(1)) {
    const m = line.match(/(?:file:\/\/)?(\/[^():]+):(\d+):\d+\)?$/);
    if (m && m[1].startsWith(HOME) && !m[1].includes('/node_modules/')) return `${m[1].slice(HOME.length)}:${m[2]}`;
  }
  return null;
}

// A short description of an error that carries no value from a file.
export function describe(e) {
  if (e instanceof Plain) return e.message;
  const kind = /^[A-Z][A-Z0-9_]*$/.test(e?.code ?? '') ? e.code : /^[A-Za-z]+$/.test(e?.name ?? '') ? e.name : 'Error';
  const msg = String(e?.message ?? '');
  const at = ['position', 'line', 'column'].flatMap((k) => {
    const n = msg.match(new RegExp(`\\b${k}\\s+(\\d+)`))?.[1];
    return n ? [`${k} ${n}`] : [];
  });
  const where = thrownIn(e);
  return [kind, at.length ? `at ${at.join(', ')}` : null, where ? `thrown in ${where}` : null].filter(Boolean).join(', ');
}

// The gap for a file an error stopped.
export const unread = (file, e) => `${file}: not read, an error stopped it (${describe(e)})`;

// Runs fn for one file; on an error, records the file as unread in gaps and
// returns fallback.
export function perFile(gaps, file, fn, fallback = undefined) {
  try { return fn(); } catch (e) { gaps.push(unread(file, e)); return fallback; }
}

// A file's text, decoded strictly: bytes that are not UTF-8 throw rather than
// turn into replacement characters, so a file that is not text is unread,
// not misread. A byte order mark is kept, so positions match the file.
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export const decode = (buf) => strict.decode(buf);
