// Renders each page through GitHub's Markdown API (gh api /markdown, mode
// gfm, in this repository's context), and parses each mermaid block with
// mermaid's own parser. The API passes a mermaid block through unparsed (the
// browser draws it later), so a broken diagram renders without an API error;
// the parser is what catches it.
//
// A page fails when the API call fails or returns nothing, when the rendered
// page has fewer mermaid sections than the page has mermaid blocks, or when a
// mermaid block does not parse. The rendered HTML is kept in
// dist/docs-check/render/.
//
// Usage: node scripts/docs/render.mjs <page> ...   exit 0 when every page renders

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'dist', 'docs-check', 'render');
const REPO = 'atishaypahadiya/Erlang';
mkdirSync(OUT, { recursive: true });

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { default: mermaid } = await import('mermaid');
mermaid.initialize({ startOnLoad: false });

let failed = 0;
const pages = process.argv.slice(2);
if (!pages.length) { console.log('render: no page given'); process.exit(64); }
for (const page of pages) {
  const text = readFileSync(join(ROOT, page), 'utf8');
  const diagrams = [...text.matchAll(/^```mermaid\n([\s\S]*?)^```$/gm)].map((m) => ({ src: m[1], line: text.slice(0, m.index).split('\n').length }));
  const r = spawnSync('gh', ['api', '/markdown', '-F', `text=@${join(ROOT, page)}`, '-f', 'mode=gfm', '-f', `context=${REPO}`], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const why = [];
  if (r.status !== 0) why.push(`gh api /markdown exited ${r.status}: ${(r.stderr ?? '').trim().split('\n')[0]}`);
  else if (!r.stdout.trim()) why.push('the API returned an empty page');
  else {
    writeFileSync(join(OUT, `${page.replaceAll('/', '_')}.html`), r.stdout);
    const sections = (r.stdout.match(/data-type="mermaid"/g) ?? []).length;
    if (sections < diagrams.length) why.push(`${diagrams.length} mermaid block(s), ${sections} rendered as mermaid`);
  }
  for (const d of diagrams) {
    try { await mermaid.parse(d.src); } catch (e) { why.push(`the mermaid block at line ${d.line} does not parse: ${String(e.message ?? e).split('\n').slice(0, 3).join(' ')}`); }
  }
  if (why.length) { failed++; for (const w of why) console.log(`FAIL  ${page}: ${w}`); } else console.log(`PASS  ${page}: rendered${diagrams.length ? `, ${diagrams.length} mermaid block(s) parsed` : ''}`);
}
if (failed) { console.log(`render: ${failed} of ${pages.length} page(s) failed`); process.exit(1); }
console.log(`render: ${pages.length} page(s) rendered (${basename(OUT)}/ holds the HTML)`);
