// A TypeScript program over a subject's source files, for the type checker:
// it follows an identifier to its declaration across the project's own
// modules (an axios instance created in one file and called in another, a
// fetch wrapped in a helper). TypeScript 6.0.3, pinned, is ERLANG's only
// runtime dependency (research/first-check.md, decision 2).
//
// The program holds only the texts lib/sources.js read: no lib.d.ts, no
// node_modules, nothing else from disk. So an import of a package resolves to
// nothing, and a check reads the package's name from the import itself; a
// global such as fetch has no declaration at all. Nothing is type-checked or
// emitted; the program exists for its symbols.

import ts from 'typescript';

export { ts };

const ROOT = '/subject';
const abs = (rel) => `${ROOT}/${rel}`;
export const relOf = (fileName) => (fileName.startsWith(`${ROOT}/`) ? fileName.slice(ROOT.length + 1) : null);

const OPTIONS = {
  allowJs: true,
  checkJs: false,
  noEmit: true,
  noLib: true,
  types: [],
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  resolveJsonModule: false,
  jsx: ts.JsxEmit.Preserve,
};

const kindOf = (rel) => (/\.tsx$/.test(rel) ? ts.ScriptKind.TSX : /\.jsx$/.test(rel) ? ts.ScriptKind.JSX : /\.[cm]?ts$/.test(rel) ? ts.ScriptKind.TS : ts.ScriptKind.JS);

// files: Map(relative path -> text). Returns { program, checker, sourceFile(rel) }.
export function build(files) {
  const byAbs = new Map([...files].map(([rel, text]) => [abs(rel), text]));
  const cache = new Map();
  const host = {
    getSourceFile(fileName, languageVersion) {
      if (!byAbs.has(fileName)) return undefined;
      if (!cache.has(fileName)) cache.set(fileName, ts.createSourceFile(fileName, byAbs.get(fileName), languageVersion, true, kindOf(fileName)));
      return cache.get(fileName);
    },
    getDefaultLibFileName: () => `${ROOT}/__no_lib__.d.ts`,
    writeFile: () => {},
    getCurrentDirectory: () => ROOT,
    getDirectories: () => [],
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => byAbs.has(f),
    readFile: (f) => byAbs.get(f),
    directoryExists: (d) => d === ROOT || [...byAbs.keys()].some((f) => f.startsWith(`${d}/`)),
    realpath: (f) => f,
  };
  const program = ts.createProgram({ rootNames: [...byAbs.keys()], options: OPTIONS, host });
  const checker = program.getTypeChecker();
  return { program, checker, sourceFile: (rel) => program.getSourceFile(abs(rel)) };
}

// 1-based line and column of a node's start (after leading trivia).
export function position(node) {
  const sf = node.getSourceFile();
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, column: character + 1 };
}

