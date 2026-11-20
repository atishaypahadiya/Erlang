// Runs ERLANG's checks on a directory of the owner's own code and writes one
// report/1. Static checks only for now: nothing is run, and no load is
// generated.
//
// Usage: erlang <dir> [--out <file>]
//   The report goes to <file>, or dist/reports/<dir name>/report.json. The
//   flag may come before or after <dir>. Every form is run by
//   scripts/cli-test.js.
//   erlang --version prints the version and the commit it runs from, so it is
//   not mistaken for the Erlang runtime (research/naming.md), and
//   "(uncommitted changes)" when tracked files differ from that commit.
// Scope: erlang.config.json at <dir> may exclude paths that are not part of
//   the app, such as test fixtures and generated output, and name request
//   handlers ERLANG cannot find itself (lib/handlers.js):
//     { "exclude": ["fixtures/", "dist/"],
//       "handlers": [{ "file": "src/worker.js", "function": "handle" }] }
//   Every report names the config and each excluded path (run.scope); a
//   config that cannot be read refuses the scan. See lib/scope.js.
// Exit codes (exitCode below; the same in ITTEN and KERCKHOFFS): 0 complete
// with no failing findings, 1 failing findings (whether or not the report is
// also partial), 2 refused, 3 partial with no failing findings (a file could
// not be read, so the silence vouches for nothing; the report's reason names
// each file and why), 64 bad usage (EX_USAGE in sysexits.h), 70 an internal
// failure (EX_SOFTWARE: a crash, lib/crash.js). An error or a
// warning fails a run; info never does, and the summary counts it apart.

import { readFileSync, statSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative, basename, join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { report, write } from '../core/report.js';
import { describe } from '../lib/isolate.js';
import { readScope, enter, leave } from '../lib/scope.js';
import * as noTimeout from '../checks/no-timeout.js';
import * as perItem from '../checks/per-item.js';
import * as unboundedQuery from '../checks/unbounded-query.js';
import * as poolSizing from '../checks/pool-sizing.js';
import * as retryPolicy from '../checks/retry-policy.js';
import * as missingIndex from '../checks/missing-index.js';
import * as poolExhaustion from '../checks/pool-exhaustion.js';
import * as blockingWork from '../checks/blocking-work.js';
import * as oversizedPayload from '../checks/oversized-payload.js';
import * as memoryGrowth from '../checks/memory-growth.js';
import * as noCache from '../checks/no-cache.js';
import * as coldStart from '../checks/cold-start.js';
import * as noLoadShedding from '../checks/no-load-shedding.js';
import { exitOnCrash } from '../lib/crash.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SPECIALIST = 'erlang';
export const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
// The commit ERLANG runs from, read from .git without running git: HEAD, a
// ref it names (loose or packed), or a worktree's .git file pointing at its
// git directory. A change not yet committed does not show. null outside a
// checkout, such as an installed copy.
export function commit(root = ROOT) {
  try {
    let git = join(root, '.git');
    if (!existsSync(git)) return null;
    let common = git;
    if (statSync(git).isFile()) {
      const m = /^gitdir: (.+)$/m.exec(readFileSync(git, 'utf8'));
      if (!m) return null;
      git = resolve(root, m[1].trim());
      const c = join(git, 'commondir');
      common = existsSync(c) ? resolve(git, readFileSync(c, 'utf8').trim()) : git;
    }
    const head = readFileSync(join(git, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref: (refs\/[\w./-]+)$/.exec(head)?.[1];
    if (!ref || ref.includes('..')) return null;
    for (const dir of [git, common]) {
      const loose = join(dir, ref);
      if (existsSync(loose)) { const sha = readFileSync(loose, 'utf8').trim(); return /^[0-9a-f]{40}$/.test(sha) ? sha : null; }
    }
    const packed = join(common, 'packed-refs');
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      const sp = line.indexOf(' ');
      if (sp === 40 && line.slice(sp + 1) === ref && /^[0-9a-f]{40}$/.test(line.slice(0, 40))) return line.slice(0, 40);
    }
    return null;
  } catch { return null; }
}

// Whether tracked files, staged or not, differ from HEAD: git diff --quiet
// HEAD exits 1 when they do, 0 when not. Untracked files do not count. null
// when git cannot say (no git, not a checkout), so nothing is claimed.
export function uncommitted(root = ROOT) {
  const r = spawnSync('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--'], { stdio: 'ignore', timeout: 10_000 });
  return r.status === 1 ? true : r.status === 0 ? false : null;
}

export const CHECKS = [noTimeout, perItem, unboundedQuery, poolSizing, retryPolicy, missingIndex, poolExhaustion, blockingWork, oversizedPayload, memoryGrowth, noCache, coldStart, noLoadShedding];
const namesOf = (c) => c.CHECKS ?? [c.CHECK];

// The subject as a path relative to the working directory, so a report never
// carries the owner's home directory.
const subjectOf = (dir) => { const r = relative(process.cwd(), dir); return r === '' ? '.' : isAbsolute(r) ? basename(dir) : r; };

// `only` limits the run to the named checks; `modules` replaces the list of
// check modules (for controls). A check returns { findings, run,
// incomplete? }: any incomplete entry makes the report partial. An error that
// escapes a check stops that check only; the report is partial and names it.
export function scan(dir, { started = new Date(), only = null, modules = CHECKS } = {}) {
  const given = resolve(dir);
  const base = { specialist: SPECIALIST, version: VERSION, subject: subjectOf(given), started };
  let root;
  try {
    root = realpathSync(given);
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
  } catch (e) {
    return report({ ...base, status: 'refused', reason: `${subjectOf(given)} cannot be read as a directory (${e.code ?? describe(e)})` });
  }
  const scope = readScope(root);
  if (scope.error) return report({ ...base, status: 'refused', reason: `${scope.error}; what is in scope is unknown, so nothing was scanned` });
  const findings = [];
  const incomplete = [];
  const run = { scope: { config: scope.config, exclude: scope.exclude, ...(scope.handlers.length ? { handlers: scope.handlers } : {}), ...(scope.smallTables.length ? { smallTables: scope.smallTables } : {}), ...(scope.database ? { database: scope.database } : {}), notes: scope.notes }, checks: {} };
  enter(root, scope.exclude);
  try {
    for (const c of only ? modules.filter((x) => namesOf(x).some((n) => only.includes(n))) : modules) {
      let r;
      try { r = c.run(root, { started, handlers: scope.handlers, smallTables: scope.smallTables, database: scope.database }); } catch (e) {
        incomplete.push(`${namesOf(c).join('+')}: stopped by an error outside any one file, so nothing it would have found is reported (${describe(e)})`);
        continue;
      }
      findings.push(...(only ? r.findings.filter((f) => only.includes(f.check)) : r.findings));
      run.checks[namesOf(c).join('+')] = r.run;
      incomplete.push(...(r.incomplete ?? []));
    }
  } finally { leave(); }
  if (incomplete.length) return report({ ...base, status: 'partial', reason: `not everything could be read: ${[...new Set(incomplete)].join('; ')}`, findings, run });
  return report({ ...base, findings, run });
}

// Error and warning fail a run; info never does.
export const failing = (f) => f.severity === 'error' || f.severity === 'warning';

export function exitCode(r) {
  if (r.status === 'refused') return 2;
  if (r.findings.some(failing)) return 1;
  return r.status === 'partial' ? 3 : 0;
}

// "complete: 2 failing (1 error, 1 warning), 3 info".
export function summaryOf(r) {
  const n = (sev) => r.findings.filter((f) => f.severity === sev).length;
  const fails = n('error') + n('warning');
  return `${r.status}: ${fails} failing (${n('error')} error, ${n('warning')} warning), ${n('info')} info`;
}

// The command line (bin/erlang.js, the bootstrap, imports this module and
// calls main; a crash after that exits 70 through exitOnCrash).
export function main(args = process.argv.slice(2)) {
  exitOnCrash('erlang');
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    const sha = commit();
    console.log(`erlang ${VERSION} (commit ${sha ?? 'unknown'}): load and resilience checks (not the Erlang runtime)${sha && uncommitted() ? ' (uncommitted changes)' : ''}`);
    process.exit(0);
  }
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args[outAt + 1] : null;
  const dir = args.find((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
  const unknown = args.filter((a, i) => a.startsWith('-') && a !== '--out' && i !== outAt + 1);
  if (!dir || (outAt >= 0 && !out) || unknown.length) {
    console.error('usage: erlang <dir> [--out <file>]   |   erlang --version');
    process.exit(64);
  }
  const r = scan(dir);
  const path = out ?? join(ROOT, 'dist', 'reports', basename(resolve(dir)) || 'root', 'report.json');
  write(path, r);
  for (const f of r.findings) {
    const loc = f.where.locations?.[0];
    console.log(`${f.severity.padEnd(7)} ${f.check}  ${loc ? `${loc.file}:${loc.line ?? ''}` : ''}  ${f.message}`);
  }
  console.log(`${summaryOf(r)}${r.reason ? ` (${r.reason})` : ''}. Report: ${relative(process.cwd(), path)}`);
  process.exit(exitCode(r));
}
