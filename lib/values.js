// A finding's values, measured and declared, and the message built from them
// (the owner, 20 November 2026; proposed for the shared finding format in
// docs/CONTRACT.md, "Measured and declared values").
//
//   text`${m.method} ${route} waited ${declared('wait', 1000, '1,000')} ms in all ${measured('waits', 6)} waits`
//
// returns { message, template, values: { measured, declared } }:
//   - message: the text a reader sees, each value shown as given;
//   - template: the same text with each value replaced by {name} (a literal
//     brace written {{ or }}), the same in every run of the same verdict;
//   - values.measured: what this run measured (times, counts, slopes,
//     shares), which differ between runs of the same subject;
//   - values.declared: what the code, the fixture or the judge declares
//     (a wait the code asks for, a bar, a scale), the same in every run.
// Any other interpolation (a route, a host, a statement's text) is part of
// the template. A name used twice is numbered: name, name2, name3.
// A value may be a number, a string or a list; `shown` is how the message
// shows it, by default String(value).

const KIND = Symbol('erlang value');
const escape = (s) => String(s).replaceAll('{', '{{').replaceAll('}', '}}');

export const measured = (name, value, shown = String(value)) => ({ [KIND]: 'measured', name, value, shown: String(shown) });
export const declared = (name, value, shown = String(value)) => ({ [KIND]: 'declared', name, value, shown: String(shown) });

// A text is also a part: its template, message and values are merged in.
const isText = (p) => p && typeof p === 'object' && typeof p.template === 'string' && p.values;

export function text(strings, ...parts) {
  const out = { message: '', template: '', values: { measured: {}, declared: {} } };
  const name = (base) => {
    let n = base;
    for (let k = 2; n in out.values.measured || n in out.values.declared; k++) n = `${base}${k}`;
    return n;
  };
  const add = (p) => {
    if (p && p[KIND]) {
      const n = name(p.name);
      out.values[p[KIND]][n] = p.value;
      out.template += `{${n}}`;
      out.message += p.shown;
    } else if (isText(p)) {
      // Renumber the inner text's names into this one's.
      let template = p.template;
      for (const kind of ['measured', 'declared']) {
        for (const [k, v] of Object.entries(p.values[kind])) {
          const n = name(k);
          out.values[kind][n] = v;
          if (n !== k) template = template.replace(new RegExp(`(?<!\\{)\\{${k}\\}(?!\\})`, 'g'), `{${n}}`);
        }
      }
      out.template += template;
      out.message += p.message;
    } else {
      out.template += escape(p);
      out.message += String(p);
    }
  };
  strings.forEach((s, i) => {
    out.template += escape(s);
    out.message += s;
    if (i < parts.length) add(parts[i]);
  });
  return out;
}

// A plain string as a text with no values.
export const plain = (s) => ({ message: String(s), template: escape(s), values: { measured: {}, declared: {} } });
export const asText = (x) => (isText(x) ? x : plain(x));

// The finding/1 `measured` paths for a finding built from a text: the
// numbers in its message, its measured values, and the evidence object's
// fields other than those that name what was judged or were declared.
// Declared evidence (a step's rate, seconds and repeats; the waits a twin's
// code declares) is compared too.
const EVIDENCE_NAMES = new Set(['judge', 'path', 'host', 'step', 'unstable', 'statement', 'streamed', 'page', 'encoding', 'unreadFields', 'symbol', 'warmup', 'rate', 'seconds', 'repeats', 'waits']);
export function measuredPaths(t, evidenceKey, evidence) {
  const paths = [];
  if (Object.keys(t.values.measured).length) paths.push('message', 'erlang.values.measured');
  for (const k of Object.keys(evidence ?? {})) if (!EVIDENCE_NAMES.has(k)) paths.push(`erlang.${evidenceKey}.${k}`);
  return paths;
}
