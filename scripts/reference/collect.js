// The facts docs/reference/ states, read from the source. Nothing is imported
// from the code it describes: every file is read as text through `read`, and
// JavaScript is parsed with TypeScript, so the same facts can be read from the
// working tree (scripts/reference.mjs) or from a tag through git (the contract
// bundle's generator). A fact the source no longer bears out throws, naming
// the file and what was expected.
//
// collect({ read, ts }) -> { commands, checks, exitCodes, output, config, limits }
//   read(path)  the text of a file, by its path from the repository root
//   ts          the typescript module

const fail = (file, what) => { throw new Error(`reference: ${file}: ${what}`); };

// What each named constant in a check means. The value is always read from
// the source; a constant listed here and missing from its file is an error,
// and so is a numeric constant in a check that is not listed here.
export const THRESHOLDS = {
  'checks/no-timeout.js': {
    MS: 'Milliseconds of the timeout or AbortSignal.timeout that an automatic fix writes.',
    MAX_CALLER_DEPTH: 'Calls followed outward when a fetch signal comes from a parameter; past it the finding is info, unresolved.',
  },
  'checks/per-item.js': {
    MAX_CALLER_DEPTH: 'Calls into project helpers followed from a per-item construct to the database call.',
  },
  'checks/unbounded-query.js': {
    PAGE: 'Rows of the default page that an automatic or guided fix writes.',
    MAX_PAGE: 'Largest page that an automatic or guided fix allows the client.',
    MAX_CALLER_DEPTH: 'Calls followed when rows are returned from a function rather than sent from the handler.',
  },
  'checks/pool-sizing.js': {
    PG_DEFAULT_MAX: "Connections counted for a pg pool with no max, pg's default.",
  },
  'checks/retry-policy.js': {
    CAP_MS: 'Milliseconds of the backoff cap that a fix writes.',
    LONG_WAIT_MS: 'Milliseconds past which growing waits with no maxTimeout are reported.',
    RETRIES: 'Attempts that an automatic fix writes in place of an unlimited retry count.',
    MAX_FN_DEPTH: 'Project functions followed when deciding whether a call is outbound, and when looking for a retry inside a retry.',
  },
  'checks/pool-exhaustion.js': {
    MAX_DEPTH: 'Variables and awaits followed back to a pg pool.',
    PG_DEFAULT_MAX: "Connections named in the message for a pg pool with no max, pg's default.",
  },
  'checks/blocking-work.js': {
    SMALL_RANDOM: 'Bytes: a synchronous randomBytes call with a literal size at most this is not reported.',
    BCRYPTJS_COST: 'bcryptjs cost: a call with a cost below this is not reported.',
    BCRYPTJS_DEFAULT: 'bcryptjs cost assumed for genSalt or genSaltSync called with no rounds.',
  },
  'checks/oversized-payload.js': {
    FIXED_LIST: 'Items: a literal list of at most this many is treated as fixed, not growing.',
  },
  'checks/memory-growth.js': {
    BOUND: 'Entries of the size bound that an automatic fix writes.',
  },
  'checks/cold-start.js': {
    MAX_DEPTH: 'Calls followed when deciding whether building a value does work.',
  },
  'checks/no-load-shedding.js': {
    MAX_DEPTH: 'Calls followed when looking for a limiter in a request hook.',
  },
};

// The forms each check recognises, as named sets in its source.
const RECOGNISED = {
  'checks/no-timeout.js': { HTTP_MODULES: 'Node HTTP modules', GOT_METHODS: 'got methods' },
  'checks/per-item.js': { NESTED_WRITES: 'Prisma nested writes' },
  'checks/unbounded-query.js': { SINKS: 'Response methods that send rows' },
  'checks/retry-policy.js': { OUTBOUND: 'Outbound clients', SLEEP_MODULES: 'Sleep modules', GOT_RETRY_METHODS: "got's retried methods", THROWS_ON_STATUS: 'Clients that throw on an error status' },
  'checks/missing-index.js': { WHERE_METHODS: 'Prisma methods whose where is read', RANGE: 'Prisma filter operators read' },
  'checks/blocking-work.js': { CHILD: 'child_process synchronous calls', BCRYPTJS: 'bcryptjs functions' },
  'checks/oversized-payload.js': { CALL_METHODS: 'Client methods counted as a call to a service' },
  'checks/memory-growth.js': { REMOVERS: 'Methods counted as removing' },
  'checks/no-cache.js': { CACHE_LIBS: 'Cache libraries', ITERATORS: 'Array methods counted as a loop' },
  'checks/no-load-shedding.js': { PRESSURE: 'Fastify pressure plugins', BUSY: 'Busy-check modules', REFUSALS: 'Status codes counted as a refusal' },
};

function parse(ts, read, file) {
  return ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
}

// Top-level constants: name -> { text, value, exported }. value is a number,
// a string, a list, or null when the initialiser is not a plain literal.
function constants(ts, sf) {
  const out = {};
  const literal = (e) => {
    if (ts.isNumericLiteral(e)) return Number(e.text.replaceAll('_', ''));
    if (ts.isStringLiteralLike(e)) return /^\d[\d_]*$/.test(e.text) ? Number(e.text.replaceAll('_', '')) : e.text;
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) { const v = literal(e.operand); return typeof v === 'number' ? -v : null; }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AsteriskToken) { const a = literal(e.left), b = literal(e.right); return typeof a === 'number' && typeof b === 'number' ? a * b : null; }
    if (ts.isArrayLiteralExpression(e)) { const xs = e.elements.map(literal); return xs.every((x) => x !== null) ? xs : null; }
    if (ts.isNewExpression(e) && e.expression.getText(sf) === 'Set' && e.arguments?.length === 1) return literal(e.arguments[0]);
    if (ts.isObjectLiteralExpression(e)) { const o = {}; for (const p of e.properties) { if (!ts.isPropertyAssignment(p)) return null; const v = literal(p.initializer); if (typeof v !== 'string') return null; o[ts.isStringLiteralLike(p.name) || ts.isIdentifier(p.name) ? p.name.text : p.name.getText(sf)] = v; } return o; }
    return null;
  };
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    const exported = !!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      out[d.name.text] = { text: d.initializer.getText(sf), value: literal(d.initializer), exported };
    }
  }
  return out;
}

const RULE_ID = /\b(?:TMO|DAT|STB|CAP|OVL|RTY|MEA)-\d{2}\b/g;
const uniq = (xs) => [...new Set(xs)];

function commands(ts, read) {
  const file = 'lib/erlang.js';
  const src = read(file);
  const usage = src.match(/console\.error\('(usage: [^']+)'\)/)?.[1] ?? fail(file, 'no usage line');
  const version = src.match(/console\.log\(`(erlang \$\{VERSION\} \(commit \$\{sha \?\? 'unknown'\}\): [^`$]+)/)?.[1] ?? fail(file, 'no version line');
  for (const s of ["args[0] === '--version' || args[0] === '-v'", "args.indexOf('--out')", 'process.exit(64)']) if (!src.includes(s)) fail(file, `no longer holds ${s}`);
  const reportAt = src.match(/const path = out \?\? join\(ROOT, ('dist', 'reports', basename\(resolve\(dir\)\) \|\| 'root', 'report\.json')\)/) ?? fail(file, 'the default report path changed');
  const pkg = JSON.parse(read('package.json'));
  const header = (f, from, to) => {
    const lines = read(f).split('\n');
    const i = lines.findIndex((l) => l.startsWith(from));
    if (i < 0) fail(f, `no "${from}" line`);
    const out = [];
    for (let j = i; j < lines.length && lines[j].startsWith('#') && !(j > i && to.some((t) => lines[j].startsWith(t))); j++) out.push(lines[j].replace(/^# ?/, ''));
    return out.join(' ').replace(/\s+/g, ' ').trim();
  };
  return {
    usage,
    version: version.replace("${VERSION}", '<version>').replace("${sha ?? 'unknown'}", '<commit>'),
    reportAt: reportAt[1],
    flags: [
      { flag: '<dir>', means: 'The directory scanned. Required unless --version is given.' },
      { flag: '--out <file>', means: 'Where the report is written. Before or after <dir>.' },
      { flag: '--version, -v', means: 'Alone, prints one version line and exits 0.' },
    ],
    other: 'Any other argument starting with - is bad usage: the usage line is printed on stderr and the exit code is 64. This includes --help.',
    scripts: Object.entries(pkg.scripts).map(([name, cmd]) => ({ name, cmd })),
    harness: [
      { file: 'scripts/trace.sh', usage: header('scripts/trace.sh', '# Usage:', ['# Outputs:']), exits: header('scripts/trace.sh', '# Exit codes:', ['#\n', '# Safety']) },
      { file: 'scripts/load.sh', usage: header('scripts/load.sh', '# Usage:', ['# Exit codes:']), exits: header('scripts/load.sh', '# Exit codes:', ['set ']) },
    ],
  };
}

function checks(ts, read) {
  const main = 'lib/erlang.js';
  const sf = parse(ts, read, main);
  const imports = {};
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamespaceImport(st.importClause.namedBindings)) {
      imports[st.importClause.namedBindings.name.text] = st.moduleSpecifier.text.replace(/^\.\.\//, '');
    }
  }
  const list = constants(ts, sf).CHECKS?.text ?? fail(main, 'no CHECKS');
  const order = list.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  return order.map((id) => {
    const file = imports[id] ?? fail(main, `CHECKS names ${id}, which is not imported as a module`);
    const src = read(file);
    const c = constants(ts, parse(ts, read, file));
    const names = c.CHECKS?.exported ? (Array.isArray(c.CHECKS.value) ? c.CHECKS.value : [c.CHECK?.value, ...c.CHECKS.text.replace(/^\[|\]$/g, '').split(',').slice(1).map((s) => s.trim().replace(/^'|'$/g, ''))]) : [c.CHECK?.value];
    if (!names.every((n) => typeof n === 'string')) fail(file, 'cannot read the check names');
    const sv = c.STRENGTH?.value;
    const strength = typeof sv === 'string' ? sv : sv && typeof sv === 'object' && !Array.isArray(sv) ? Object.entries(sv).map(([k, v]) => `${v} for ${k}`).join(', ') : null;
    if (c.STRENGTH && !strength) fail(file, 'STRENGTH is not a literal');
    const known = THRESHOLDS[file] ?? {};
    for (const k of Object.keys(known)) if (!(k in c)) fail(file, `the constant ${k} is described but no longer declared`);
    const numeric = Object.entries(c).filter(([, v]) => typeof v.value === 'number');
    for (const [k] of numeric) if (!(k in known)) fail(file, `the numeric constant ${k} has no description in scripts/reference/collect.js`);
    const thresholds = Object.entries(known).map(([name, means]) => {
      const v = c[name].value;
      if (typeof v !== 'number') fail(file, `${name} is not a number`);
      return { name, value: v, means };
    });
    const sets = Object.entries(RECOGNISED[file] ?? {}).map(([name, what]) => {
      const v = c[name]?.value;
      if (!Array.isArray(v)) fail(file, `the set ${name} is no longer a literal list`);
      return { name, what, items: v };
    });
    return { file, names, rules: uniq(src.match(RULE_ID) ?? []).sort(), strength, thresholds, sets };
  });
}

function exitCodes(ts, read) {
  const file = 'lib/erlang.js';
  const src = read(file);
  const fn = src.match(/export function exitCode\(r\) \{\n([\s\S]*?)\n\}/)?.[1] ?? fail(file, 'no exitCode');
  const expect = ["if (r.status === 'refused') return 2;", 'if (r.findings.some(failing)) return 1;', "return r.status === 'partial' ? 3 : 0;"];
  if (fn.split('\n').map((l) => l.trim()).join('\n') !== expect.join('\n')) fail(file, 'exitCode is not the function this reference describes');
  if (!src.includes("export const failing = (f) => f.severity === 'error' || f.severity === 'warning';")) fail(file, 'failing changed');
  const crash = read('lib/crash.js').match(/export const EXIT_INTERNAL = (\d+);/)?.[1] ?? fail('lib/crash.js', 'no EXIT_INTERNAL');
  const boot = read('bin/erlang.js');
  if (!boot.includes('process.exit(70)')) fail('bin/erlang.js', 'the bootstrap no longer exits 70');
  return [
    { code: 0, means: 'The report is complete and no finding is an error or a warning.', from: 'lib/erlang.js, exitCode' },
    { code: 1, means: 'At least one finding is an error or a warning, whatever the status.', from: 'lib/erlang.js, exitCode' },
    { code: 2, means: 'The report is refused.', from: 'lib/erlang.js, exitCode' },
    { code: 3, means: 'The report is partial and no finding is an error or a warning.', from: 'lib/erlang.js, exitCode' },
    { code: 64, means: 'The arguments are not a usage the command accepts.', from: 'lib/erlang.js, main' },
    { code: Number(crash), means: 'An internal failure: an uncaught exception or rejection, or a module that fails to load.', from: 'lib/crash.js, EXIT_INTERNAL; bin/erlang.js' },
  ];
}

// A schema's properties as rows: { name, type, required, description }.
function fields(schema, prefix = '') {
  const req = new Set(schema.required ?? []);
  const rows = [];
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    const type = v.type ? [].concat(v.type).join(' or ') : v.const !== undefined ? `"${v.const}"` : v.enum ? v.enum.map((e) => `"${e}"`).join(', ') : v.$ref ? v.$ref.replace(/^#\/\$defs\//, '') : '';
    rows.push({ name: prefix + k, type: v.enum && v.type ? `${type}: ${v.enum.map((e) => `"${e}"`).join(', ')}` : type, required: req.has(k), description: v.description ?? '' });
    if (v.properties) rows.push(...fields(v, `${prefix}${k}.`));
    if (v.items?.properties) rows.push(...fields(v.items, `${prefix}${k}[].`));
  }
  return rows;
}

function output(ts, read) {
  const src = read('lib/erlang.js');
  const line = src.match(/^ *console\.log\(`(\$\{f\.severity\.padEnd\(7\)\} .*)`\);$/m)?.[1] ?? fail('lib/erlang.js', 'the finding line changed');
  const summary = src.match(/return `(\$\{r\.status\}: [^`]+)`;/)?.[1] ?? fail('lib/erlang.js', 'the summary changed');
  const schema = (f) => { const s = JSON.parse(read(f)); return { file: f, title: s.title ?? '', description: s.description ?? '', rows: fields(s) }; };
  return {
    stdout: { line, summary },
    schemas: [schema('core/schema/report.schema.json'), schema('core/schema/finding.schema.json'), schema('schema/finding-erlang.schema.json')],
  };
}

function config(ts, read) {
  const f = 'schema/config.schema.json';
  const s = JSON.parse(read(f));
  if (s.additionalProperties !== false) fail(f, 'the config now allows other keys');
  if (!read('lib/erlang.js').includes('readScope')) fail('lib/erlang.js', 'no longer reads the config through lib/scope.js');
  return { file: f, at: 'erlang.config.json at the root of <dir>', description: s.description ?? '', rows: fields(s) };
}

function limits(ts, read) {
  const f = 'lib/sources.js';
  const c = constants(ts, parse(ts, read, f));
  const dirs = c.OUTPUT_DIRS?.value ?? fail(f, 'no OUTPUT_DIRS');
  const bytes = c.MAX_BYTES?.value ?? fail(f, 'no MAX_BYTES');
  const source = c.SOURCE?.text ?? fail(f, 'no SOURCE');
  if (!read(f).includes('e.isSymbolicLink()')) fail(f, 'symlinks are no longer skipped');
  const h = read('lib/handlers.js').split('\n');
  const from = h.findIndex((l) => l.startsWith('// Found in the source, with no configuration:'));
  const to = h.findIndex((l, i) => i > from && !l.startsWith('//   '));
  if (from < 0 || to < 0) fail('lib/handlers.js', 'the list of handler forms changed');
  const forms = [];
  for (const l of h.slice(from + 1, to)) {
    const m = l.match(/^\/\/ {3}(\S+(?: \S+)?)\s{2,}(.*)$/);
    if (m && /^[A-Za-z]/.test(m[1]) && !/^\s/.test(l.slice(5, 6))) forms.push({ framework: m[1], forms: m[2] });
    else if (forms.length) forms.at(-1).forms += ` ${l.replace(/^\/\/\s+/, '')}`;
  }
  return { file: f, dirs, bytes, source, handlers: forms };
}

export function collect({ read, ts }) {
  return {
    commands: commands(ts, read),
    checks: checks(ts, read),
    exitCodes: exitCodes(ts, read),
    output: output(ts, read),
    config: config(ts, read),
    limits: limits(ts, read),
  };
}
