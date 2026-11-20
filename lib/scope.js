// What a scan covers: the subject's directory, less what its owner excludes
// in erlang.config.json at the scan root (schema/config.schema.json):
//
//   { "exclude": ["fixtures/", "dist/", "docs/example.env"] }
//
// It may also name request handlers ERLANG cannot find in the source (the
// brief, read by lib/handlers.js):
//
//   { "handlers": [{ "file": "src/worker.js", "function": "handle",
//                    "method": "POST", "route": "/jobs" }] }
//
// and tables the owner states stay small, whose reads unbounded-query does
// not report:
//
//   { "smallTables": ["settings", "Country"] }
//
// and the database's connection limit, when no deployment file in the
// repository states it (a managed database), for pool-sizing:
//
//   { "database": { "maxConnections": 200 } }
//
// Each entry is a path relative to the scan root, with / separators: a
// directory (a trailing / is optional) excludes everything under it, a file
// excludes that file. No globs, no "..", nothing absolute. The config is read
// at the scan root only, never above or below it.
//
// Exclusion is the owner's statement that a path is not part of the app
// (test fixtures with planted defects, generated reports). It is never
// silent: every report names the config and each excluded path in its run
// data, and an entry that matches nothing is a note. A config that cannot be
// read or does not match the schema refuses the scan: what is in scope would
// be unknown.
//
// Every walker reads the active scope through excluded(), so a scan sets it
// once (enter) and clears it when done (leave).

import { readFileSync, existsSync } from 'node:fs';
import { join, relative, sep, isAbsolute } from 'node:path';
import { validate } from '../core/schema.js';
import { decode, describe } from './isolate.js';

export const CONFIG = 'erlang.config.json';
const schema = JSON.parse(readFileSync(new URL('../schema/config.schema.json', import.meta.url), 'utf8'));

// The scan root's config: { exclude: [...], notes: [] }, or { error } when
// it cannot be read or does not match the schema. No config: nothing
// excluded.
export function readScope(root) {
  const at = join(root, CONFIG);
  if (!existsSync(at)) return { config: null, exclude: [], handlers: [], smallTables: [], database: null, warmup: null, notes: [] };
  let cfg;
  try { cfg = JSON.parse(decode(readFileSync(at)).replace(/^\uFEFF/, "")); } catch (e) { return { error: `${CONFIG} is not valid JSON (${describe(e)})` }; }
  const errors = validate(schema, cfg);
  if (errors.length) return { error: `${CONFIG} does not match schema/config.schema.json: ${errors.join('; ')}` };
  const exclude = [...new Set((cfg.exclude ?? []).map((p) => p.replace(/\/$/, '')))];
  const notes = exclude.filter((p) => !existsSync(join(root, p))).map((p) => `${CONFIG}: exclude entry ${p} matches nothing`);
  return { config: CONFIG, exclude, handlers: cfg.handlers ?? [], smallTables: cfg.smallTables ?? [], database: cfg.database ?? null, warmup: cfg.warmup ?? null, notes };
}

let active = null;
export const enter = (root, exclude) => { active = { root, exclude }; };
export const leave = () => { active = null; };

// Whether an absolute path is excluded from the active scan.
export function excluded(abs) {
  if (!active || !active.exclude.length) return false;
  const rel = relative(active.root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  const p = rel.split(sep).join('/');
  return active.exclude.some((x) => p === x || p.startsWith(`${x}/`));
}

// The warm-up a trace harness sends before a fresh process's first requests
// (judge "starts", cold-start): the form's own (trace.json "warmup", a route
// its overlay adds), else the app's (erlang.config.json "warmup"), else a
// path that does not exist, expected to answer 404, which warms the framework
// but not the database driver. The report says which ran.
// The fallback's path is FALLBACK_WARMUP followed by a random suffix, new at
// every start, so it cannot match a real route; it is sent as a GET and then
// as a POST with a small JSON body, which warms the app's body parser and
// changes nothing (the owner, 20 November 2026).
export const FALLBACK_WARMUP = '/__erlang/warm-up-not-found-';
export const FALLBACK_BODY = { erlang: 'warm-up' };
export function warmupFor(formWarmup, twinDir) {
  if (formWarmup) return { source: 'trace.json', method: formWarmup.method ?? 'GET', path: formWarmup.path, ...(formWarmup.body !== undefined ? { body: formWarmup.body } : {}) };
  const scope = readScope(twinDir);
  if (scope.error) throw new Error(scope.error);
  if (scope.warmup) return { source: 'erlang.config.json', method: scope.warmup.method ?? 'GET', path: scope.warmup.path };
  return { source: 'fallback', method: 'GET', path: FALLBACK_WARMUP };
}
