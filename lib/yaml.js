// A reader for the YAML that deployment files use (Docker Compose,
// Kubernetes manifests): block mappings and sequences, plain and quoted
// scalars, flow sequences of scalars, comments, block scalars (kept as text)
// and several documents separated by ---. Anchors, aliases, tags and flow
// mappings are not read; a value using one is kept as its raw text. ERLANG
// has no YAML dependency (research/first-check.md, decision 2), and pool-
// sizing needs only numbers and names from these files.
//
// Every mapping carries a non-enumerable $lines: key -> 1-based line, so a
// finding can point at the line a number came from.

export function parseYaml(text) {
  const docs = [];
  let lines = [];
  const flush = () => { if (lines.some((l) => l.text.trim())) docs.push(parseBlock(lines)); lines = []; };
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^---(\s|$)/.test(raw)) { flush(); return; }
    if (/^\.\.\.(\s|$)/.test(raw)) return;
    lines.push({ text: raw, line: i + 1 });
  });
  flush();
  return docs;
}

const indentOf = (s) => s.match(/^ */)[0].length;
const stripComment = (s) => {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
};

function scalar(s) {
  s = s.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (/^".*"$/.test(s)) return s.slice(1, -1).replace(/\\"/g, '"');
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).map(scalar);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function mapping() {
  const m = {};
  Object.defineProperty(m, '$lines', { value: {}, enumerable: false });
  return m;
}

function parseBlock(all) {
  const rows = all.map((l) => ({ ...l, body: stripComment(l.text).replace(/\s+$/, '') })).filter((l) => l.body.trim());
  let i = 0;
  const parse = (indent) => {
    if (i >= rows.length) return null;
    const first = rows[i];
    const isSeq = first.body.trim().startsWith('- ') || first.body.trim() === '-';
    if (isSeq) {
      const out = [];
      while (i < rows.length && indentOf(rows[i].body) === indent && /^-( |$)/.test(rows[i].body.trim())) {
        const row = rows[i];
        const rest = row.body.trim().slice(1).trimStart();
        if (!rest) { i++; out.push(i < rows.length && indentOf(rows[i].body) > indent ? parse(indentOf(rows[i].body)) : null); continue; }
        if (/^[^'"[{][^:]*:(\s|$)/.test(rest) || /^["'][^"']*["']\s*:(\s|$)/.test(rest)) {
          // A mapping that starts on the dash line: re-read it as indented.
          const inner = indent + (row.body.length - row.body.trimStart().length - indent) + 2;
          rows[i] = { ...row, body: ' '.repeat(inner) + rest };
          out.push(parse(inner));
          continue;
        }
        out.push(scalar(rest));
        i++;
      }
      return out;
    }
    const m = mapping();
    while (i < rows.length && indentOf(rows[i].body) === indent) {
      const row = rows[i];
      const t = row.body.trim();
      const km = t.match(/^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/);
      if (!km) { i++; continue; }
      const key = scalar(km[1]);
      const rest = km[2] ?? '';
      m.$lines[key] = row.line;
      i++;
      if (/^[|>][+-]?\d*$/.test(rest)) {
        const parts = [];
        while (i < rows.length && indentOf(rows[i].body) > indent) parts.push(rows[i++].text.trim());
        m[key] = parts.join(rest.startsWith('>') ? ' ' : '\n');
      } else if (rest) {
        m[key] = scalar(rest);
      } else if (i < rows.length && (indentOf(rows[i].body) > indent || (indentOf(rows[i].body) === indent && rows[i].body.trim().startsWith('-')))) {
        m[key] = parse(indentOf(rows[i].body));
      } else {
        m[key] = null;
      }
    }
    return m;
  };
  return parse(rows.length ? indentOf(rows[0].body) : 0);
}
