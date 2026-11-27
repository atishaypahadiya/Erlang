// Runs every fenced bash block of README.md, in order, in one shell from the
// repository root, as a reader following the page would. The info string can
// carry two words after the language:
//   needs=docker   or   needs=network   the block is skipped, with a line saying so
//   exit=N                              the exit status the block must end with (default 0)
// Nothing else is skipped. A block written in another shell language (sh,
// shell, console, zsh) fails the test, so none is missed.
//
// Usage: node scripts/docs/blocks.js [file]   exit 0 when every block ends as it says

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = resolve(process.argv[2] ?? join(ROOT, 'README.md'));
const OUT = join(ROOT, 'dist', 'docs-check', 'blocks');
const lines = readFileSync(FILE, 'utf8').split('\n');

const blocks = [];
for (let i = 0; i < lines.length; i++) {
  const open = lines[i].match(/^( *)(`{3,})(\S*)\s*(.*)$/);
  if (!open) continue;
  const [, indent, fence, lang, rest] = open;
  const end = lines.findIndex((l, j) => j > i && l.trim() === fence);
  if (end < 0) { console.log(`FAIL  ${FILE}:${i + 1}: a fence that is never closed`); process.exit(1); }
  const attrs = Object.fromEntries(rest.split(/\s+/).filter(Boolean).map((w) => w.split('=')));
  if (['sh', 'shell', 'console', 'zsh'].includes(lang)) { console.log(`FAIL  line ${i + 1}: a ${lang} block; write shell commands as bash blocks so they are run`); process.exit(1); }
  if (lang === 'bash') blocks.push({ line: i + 1, body: lines.slice(i + 1, end).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n'), needs: attrs.needs ?? null, exit: attrs.exit === undefined ? 0 : Number(attrs.exit) });
  i = end;
}
if (!blocks.length) { console.log(`FAIL  ${FILE} has no bash block`); process.exit(1); }
for (const b of blocks) {
  if (b.needs && !['docker', 'network'].includes(b.needs)) { console.log(`FAIL  line ${b.line}: needs=${b.needs}; only docker and network are skipped`); process.exit(1); }
  if (!Number.isInteger(b.exit)) { console.log(`FAIL  line ${b.line}: exit= must be a number`); process.exit(1); }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const run = blocks.filter((b) => !b.needs);
const script = ['cd "$1"', 'set +e'];
run.forEach((b, n) => {
  const at = join(OUT, `block-${n + 1}.sh`);
  writeFileSync(at, `${b.body}\n`);
  script.push(`echo "README block at line ${b.line}: running"`, `source ${JSON.stringify(at)}`, 'c=$?', `if [ "$c" -ne ${b.exit} ]; then echo "FAIL  README block at line ${b.line} ended with $c, not ${b.exit}"; exit 1; fi`, `echo "PASS  README block at line ${b.line} (exit ${b.exit})"`);
});
writeFileSync(join(OUT, 'run.sh'), `${script.join('\n')}\n`);
for (const b of blocks.filter((x) => x.needs)) console.log(`SKIP  README block at line ${b.line}: needs ${b.needs}`);
const r = spawnSync('bash', [join(OUT, 'run.sh'), ROOT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const shown = (r.stdout ?? '').split('\n').filter((l) => /^(PASS|FAIL) /.test(l));
console.log(shown.join('\n'));
if (r.status !== 0) {
  console.log((r.stdout ?? '').split('\n').slice(-20).join('\n'), r.stderr ?? '');
  console.log(`blocks: failed; the blocks' output is above, and the scripts are in ${OUT}`);
  process.exit(1);
}
console.log(`blocks: ${run.length} bash block(s) ran as the page says; ${blocks.length - run.length} skipped (docker or network)`);
