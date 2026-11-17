// The source files of a subject, as the static checks read them: every
// JavaScript and TypeScript file under the scan root, less build output,
// dependencies, version control and what erlang.config.json excludes
// (lib/scope.js). Symlinks are never followed. Each file is read on its own
// (lib/isolate.js): one that cannot be opened, is not UTF-8, or is too large
// to be source is recorded as unread and the walk goes on.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { excluded } from './scope.js';
import { perFile, decode, Plain } from './isolate.js';

export const OUTPUT_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.output', '.vercel', '.netlify', '.astro', '.turbo', '.cache', 'coverage']);
export const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
// Larger than any hand-written module; minified bundles are build output.
export const MAX_BYTES = 1024 * 1024;

const posixRel = (root, abs) => relative(root, abs).split(sep).join('/');

// { files: Map(relative path -> text), gaps: [...] }.
export function readSources(root) {
  const files = new Map();
  const gaps = [];
  const visit = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) {
      perFile(gaps, posixRel(root, dir) || '.', () => { throw e; });
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const abs = join(dir, e.name);
      if (e.isSymbolicLink() || excluded(abs)) continue;
      if (e.isDirectory()) { if (!OUTPUT_DIRS.has(e.name)) visit(abs); continue; }
      if (!e.isFile() || !SOURCE.test(e.name) || /\.d\.[cm]?ts$/.test(e.name)) continue;
      const rel = posixRel(root, abs);
      perFile(gaps, rel, () => {
        if (statSync(abs).size > MAX_BYTES) throw new Plain(`larger than ${MAX_BYTES} bytes, so not read as source`);
        files.set(rel, decode(readFileSync(abs)));
      });
    }
  };
  visit(root);
  return { files, gaps };
}
