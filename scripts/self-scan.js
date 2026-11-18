// ERLANG on its own repository, through the CLI: the report must be complete
// with no findings. erlang.config.json excludes fixtures/ (the planted
// defects), dist/ (copies of them and generated reports) and research/probes/
// (probes that run per-item queries on purpose), and the report must say so.
//
// Usage: node scripts/self-scan.js            exit 0 when the repository is clean

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = join(ROOT, 'dist', 'self', 'report.json');
const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'erlang.js'), ROOT, '--out', at], { cwd: ROOT, encoding: 'utf8' });
let rep = null;
try { rep = JSON.parse(readFileSync(at, 'utf8')); } catch { /* reported below */ }
const scope = rep?.erlang?.scope;
const good = r.status === 0 && rep?.status === 'complete' && rep.findings.length === 0
  && scope?.config === 'erlang.config.json' && ['fixtures', 'dist', 'research/probes'].every((p) => scope.exclude.includes(p));
console.log(`${good ? 'PASS' : 'FAIL'}  self-scan: complete, 0 findings, fixtures/, dist/ and research/probes/ excluded  (exit ${r.status}; ${r.stdout.trim().split('\n').at(-1) ?? ''})`);
if (!good) for (const f of rep?.findings ?? []) console.log(`      ${f.check} ${f.where.locations?.[0]?.file}:${f.where.locations?.[0]?.line ?? ''}`);
process.exit(good ? 0 : 1);
