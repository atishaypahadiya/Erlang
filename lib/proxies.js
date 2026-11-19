// Proxy configuration in the repository: nginx, Caddy and HAProxy files,
// read as text with comments removed. Used by checks that let a proxy in
// front of the app do the job (compression, connection limits).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { OUTPUT_DIRS, MAX_BYTES } from './sources.js';
import { excluded } from './scope.js';
import { perFile, decode } from './isolate.js';

const PROXY_FILE = /(^|\/)(nginx[^/]*\.conf|[^/]*\.nginx|default\.conf|Caddyfile|haproxy[^/]*\.cfg)$/;

// [{ file, text }] for every proxy file under root, skipping output
// directories, excluded paths, symbolic links and files over MAX_BYTES.
// A file that cannot be read is recorded in gaps.
export function proxyFiles(root, gaps) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink() || excluded(abs)) continue;
      if (e.isDirectory()) { if (!OUTPUT_DIRS.has(e.name)) walk(abs, r); continue; }
      if (!e.isFile() || !PROXY_FILE.test(r)) continue;
      perFile(gaps, r, () => {
        if (statSync(abs).size > MAX_BYTES) return;
        out.push({ file: r, text: decode(readFileSync(abs)).replace(/#[^\n]*/g, '') });
      });
    }
  };
  walk(root, '');
  return out;
}
