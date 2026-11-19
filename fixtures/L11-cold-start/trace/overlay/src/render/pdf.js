// The L11 trace form's stand-in for a large PDF library, in place of the
// twin's tiny one (see trace/overlay/trace-entry.js): it builds its glyph
// tables when it loads, as a large library does, so loading it takes time.
const widths = new Map();
for (let font = 0; font < 40; font++) for (let code = 0; code < 20_000; code++) widths.set(`${font}:${code}`, ((code * 31 + font * 7) % 1000) / 1000);

export function render(invoice) {
  return Buffer.from(`%PDF-1.4\n% invoice ${invoice?.id ?? ''}, ${invoice?.total_cents ?? 0} cents, ${widths.size} glyphs\n%%EOF\n`);
}
