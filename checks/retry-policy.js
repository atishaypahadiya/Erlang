// retry-policy (RTY-01, RTY-03, RTY-06; fixture L06): retries of outbound
// calls with no cap on attempts, no backoff or no jitter, or that retry
// replies that cannot succeed, in code a request handler reaches. Static:
// reads source, runs nothing.
//
// Read as a resolved policy (attempts, waits, jitter, what is retried):
//   axios-retry  retries 3, retryDelay noDelay (no wait), exponentialDelay
//                2^n × 100 ms plus 0-20 % jitter; every built-in delay
//                honours Retry-After (4.5.0 source; research C9);
//   p-retry      retries 10, factor 2, minTimeout 1 s, maxTimeout Infinity,
//                randomize false; retries every thrown error but AbortError
//                (9.0.0; C10);
//   got          limit 2, 1 s, 2 s, 4 s ... plus 0-100 ms noise, backoffLimit
//                Infinity, honours Retry-After (16.2.0; C11);
//   hand-written loops: a for/while/do loop (not for-of) around an outbound
//                call (fetch, axios, got, undici, node:http, or a project
//                function that makes one), that leaves on success (a return
//                or break in the try, or after a res.ok test) and goes round
//                again on failure.
// Reported:
//   - error (RTY-01): no cap on attempts (while (true), Infinity);
//   - error (RTY-03): no wait, a fixed or linear wait, or exponential with
//     no randomness; a jittered wait with no cap past 60 s;
//   - warning (RTY-03): a jittered wait that does not grow;
//   - warning (RTY-06): every failure retried, 400 and 404 included, where
//     the call throws on any status (axios, got, or a throw after !res.ok)
//     or the loop retries any reply that is not ok. Bounded by the cap, so
//     wasted calls rather than an outage.
// Not reported: a retry no request handler reaches (a migration at startup,
// a script); a for-of over items; a loop whose catch leaves it; a polling
// loop that ends on content, not on a reply succeeding. With no handler
// found, every finding is info.
//
// Fixes: a library option that sets the wait or cap is set automatically,
// and a loop's fixed or linear wait becomes full jitter,
// Math.random() * Math.min(10_000, base × 2 ** attempt). A missing cap, a
// missing wait and what is retried are guided.

import { ts, build, position, relOf } from '../lib/program.js';
import { unwrap, declOf, evalObject, lookup, symbolAt, origin, isLib, isGlobal } from '../lib/resolve.js';
import { readSources } from '../lib/sources.js';
import { perFile } from '../lib/isolate.js';
import { findHandlers, functionOf } from '../lib/handlers.js';
import { finding, fingerprint } from '../core/finding.js';
import { replaceNode, insertProperty, appendArgument } from '../lib/fix.js';

export const CHECK = 'retry-policy';
export const CHECKS = [CHECK, 'retry-budget'];
const GOT_RETRY_METHODS = new Set(['GET', 'PUT', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'QUERY']);
const LAYERS_NOTE = "Retry at one layer only, the one directly above the call (RTY-02): turn the inner retry off for this call (axios-retry: { 'axios-retry': { retries: 0 } } in the request's config; got: retry: { limit: 0 }) and keep the outer policy, or drop the outer retry and keep the inner one.";
const BUDGET_NOTE = 'Keep one retry budget per process, shared by every retry, and consult it where the retry is decided, failing when it is spent (RTY-05): a token bucket (say 10 tokens, 1 spent per retry, 0.1 earned per request that succeeds first time), or a retry allowed only while retries are under 10% of requests, as Google does.';
const STRENGTH = 'MUST';
const CAP_MS = 10_000;
const LONG_WAIT_MS = 60_000;
const RETRIES = 2;
const OUTBOUND = new Set(['axios', 'got', 'undici', 'node-fetch', 'ky', 'node:http', 'node:https', 'http', 'https']);
const THROWS_ON_STATUS = new Set(['axios', 'got', 'ky']);
const SLEEP_MODULES = new Set(['delay', 'p-sleep', 'sleep-promise', 'timers-ext']);
const BACKOFF_NOTE = `${CAP_MS / 1000} s as the cap is a starting value (fixtures/PLAN.md, L06): full jitter waits a random time between 0 and min(cap, base × 2^attempt) (RTY-03, RTY-04).`;
const MAX_FN_DEPTH = 3;

export function run(root, { handlers: brief = [] } = {}) {
  const { files, gaps } = readSources(root);
  const cx = { ...build(files), files };
  const rels = [...files.keys()].sort();
  const H = findHandlers(cx, rels, gaps, brief);
  const findings = [];
  const stats = { files: files.size, handlers: H.handlers.length, sites: { 'axios-retry': 0, 'p-retry': 0, got: 0, loop: 0 }, skipped: { outsideRequests: 0, unreadable: 0 }, notes: H.notes };
  const sites = [];
  const retriers = [];
  const loopMeta = new Map();

  for (const rel of rels) {
    perFile(gaps, rel, () => {
      const visit = (n) => {
        if (ts.isCallExpression(n)) {
          const o = origin(cx, n.expression);
          if (isLib(o, 'axios-retry')) sites.push({ kind: 'axios-retry', node: n });
          else if (isLib(o, 'p-retry')) sites.push({ kind: 'p-retry', node: n });
          else if (isGot(o)) for (const a of n.arguments) { const r = lookup(evalObject(cx, a), 'retry'); if (!r.absent && !r.open && ts.isObjectLiteralExpression(unwrap(r.value) ?? n)) sites.push({ kind: 'got', node: n, retry: unwrap(r.value) }); }
        }
        if (ts.isForStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) sites.push({ kind: 'loop', node: n });
        ts.forEachChild(n, visit);
      };
      visit(cx.sourceFile(rel));
    });
  }

  for (const s of sites) perFile(gaps, fileOf(s.node), () => {
    const issues = s.kind === 'axios-retry' ? axiosRetry(s.node) : s.kind === 'p-retry' ? pRetry(s.node) : s.kind === 'got' ? gotRetry(s.node, s.retry) : loop(s.node);
    if (!issues) return;
    stats.sites[s.kind]++;
    retriers.push(s);
    if (!issues.length) return;
    const reach = reachOf(s);
    if (H.handlers.length && !reach.length) { stats.skipped.outsideRequests++; return; }
    for (const i of issues) report(s, i, reach);
  });

  // ---- axios-retry ----

  function axiosRetry(call) {
    const callee = call.expression.getText();
    const optsNode = unwrap(call.arguments[1]);
    const opts = evalObject(cx, optsNode);
    if (opts.entries.some((e) => e.open)) { stats.skipped.unreadable++; return []; }
    const literal = optsNode && ts.isObjectLiteralExpression(optsNode) ? optsNode : null;
    const issues = [];
    const retries = lookup(opts, 'retries');
    const n = retries.absent ? 3 : numberOf(retries.value);
    const policy = { retrier: 'axios-retry', attempts: n === Infinity ? 'unbounded' : n === null ? undefined : n + 1 };
    if (n === Infinity) issues.push({ rule: 'RTY-01', issue: 'attempts', severity: 'error', policy, what: `retries: Infinity, so a failing service is called for as long as the request lasts`, fix: { kind: 'auto', edits: [replaceNode(fileOf(call), unwrap(retries.value), String(RETRIES))], note: `retries: ${RETRIES} is three attempts in all, Google's limit (RTY-01); a starting value.` } });
    const delay = lookup(opts, 'retryDelay');
    const shape = delay.absent ? { backoff: 'none', jitter: false, how: 'retryDelay is not set: its default, noDelay, waits only when a reply carries Retry-After' } : axiosDelay(delay.value);
    if (shape && (shape.backoff !== 'exponential' || !shape.jitter)) {
      const exp = `${callee}.exponentialDelay`;
      const edit = delay.absent ? (literal ? insertProperty(fileOf(call), literal, `retryDelay: ${exp}`) : !optsNode ? appendArgument(fileOf(call), call, `{ retryDelay: ${exp} }`) : null) : replaceNode(fileOf(call), unwrap(delay.value), exp);
      issues.push({ rule: 'RTY-03', issue: 'backoff', severity: 'error', policy: { ...policy, backoff: shape.backoff, jitter: shape.jitter }, what: `${n === null ? 'its retries' : `${n} retries`}, and ${shape.how}, so every client that failed together retries together`, fix: edit ? { kind: 'auto', edits: [edit], note: `exponentialDelay waits 2^n × 100 ms plus up to 20 % jitter, and honours Retry-After.` } : guided([call], `Set retryDelay to ${exp}.`) });
    }
    const cond = lookup(opts, 'retryCondition');
    if (!cond.absent && returnsTrue(cond.value)) issues.push({ rule: 'RTY-06', issue: 'status', severity: 'warning', policy, what: 'retryCondition retries every failure, so 400, 401 and 404 replies are sent again though they cannot succeed', fix: guided([cond.value], 'Retry network errors, 429 and 5xx only: axios-retry\'s default, isNetworkOrIdempotentRequestError, does.') });
    return issues;
  }
  function axiosDelay(v) {
    v = unwrap(v);
    const o = ts.isCallExpression(v) ? origin(cx, v.expression) : origin(cx, v);
    const name = o.k === 'import' && o.module === 'axios-retry' ? o.path.at(-1) : null;
    if (name === 'exponentialDelay') return { backoff: 'exponential', jitter: true };
    if (name === 'linearDelay') return { backoff: 'linear', jitter: false, how: 'linearDelay waits a growing step with no randomness' };
    const fn = ts.isArrowFunction(v) || ts.isFunctionExpression(v) ? v : functionOf(cx, v);
    if (!fn) return null;
    const body = ts.isBlock(fn.body) ? returnsOf(fn.body) : [fn.body];
    if (body.length !== 1) return null;
    const counter = fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name) ? [cx.checker.getSymbolAtLocation(fn.parameters[0].name)] : [];
    const s = delayShape(body[0], counter, null);
    return s.backoff === 'unknown' ? null : { ...s, how: `retryDelay ${describeWait(s, body[0])}` };
  }

  // ---- p-retry ----

  function pRetry(call) {
    const optsNode = unwrap(call.arguments[1]);
    const opts = evalObject(cx, optsNode);
    if (opts.entries.some((e) => e.open)) { stats.skipped.unreadable++; return []; }
    const literal = optsNode && ts.isObjectLiteralExpression(optsNode) ? optsNode : null;
    const get = (k, d) => { const r = lookup(opts, k); return r.absent ? d : r.value.kind === ts.SyntaxKind.TrueKeyword ? true : r.value.kind === ts.SyntaxKind.FalseKeyword ? false : numberOf(r.value); };
    const retries = get('retries', 10), factor = get('factor', 2), min = get('minTimeout', 1000), max = get('maxTimeout', Infinity), maxTime = get('maxRetryTime', Infinity), randomize = get('randomize', false);
    const policy = { retrier: 'p-retry', attempts: retries === Infinity ? 'unbounded' : retries === null ? undefined : retries + 1 };
    const issues = [];
    if (retries === Infinity && maxTime === Infinity) {
      const r = lookup(opts, 'retries');
      issues.push({ rule: 'RTY-01', issue: 'attempts', severity: 'error', policy, what: 'retries: Infinity with no maxRetryTime, so a failing service is called for as long as the request lasts', fix: { kind: 'auto', edits: [replaceNode(fileOf(call), unwrap(r.value), String(RETRIES))], note: `retries: ${RETRIES} is three attempts in all, Google's limit (RTY-01); a starting value.` } });
    }
    if ([factor, min, max, retries].some((x) => x === null) || randomize === null) return issues;
    const longest = retries === Infinity ? Infinity : Math.min(max, min * factor ** Math.max(0, retries - 1) * (randomize ? 2 : 1));
    const add = [];
    let what = null, backoff = factor > 1 ? 'exponential' : 'fixed';
    if (min === 0) { backoff = 'none'; what = 'minTimeout: 0, so it retries at once'; }
    else if (randomize !== true) { what = `${factor > 1 ? `waits ${fmt(min)}, ${fmt(min * factor)}, ${fmt(min * factor ** 2)} and so on` : `waits ${fmt(min)} each time`} with randomize false, its default: no jitter, so every client that failed together retries together`; add.push('randomize: true'); }
    if (min !== 0 && longest > LONG_WAIT_MS && max === Infinity) { what = `${what ? `${what}; and ` : ''}its waits grow with no maxTimeout, to ${retries === Infinity ? 'no limit' : fmt(longest)} before the last attempt`; add.push(`maxTimeout: ${CAP_MS.toLocaleString('en-US').replace(/,/g, '_')}`); }
    if (what) {
      const edit = backoff === 'none' ? null : literal && add.every((a) => !lookup(opts, a.split(':')[0]).node) ? insertProperty(fileOf(call), literal, add.join(', ')) : !optsNode ? appendArgument(fileOf(call), call, `{ ${add.join(', ')} }`) : null;
      issues.push({ rule: 'RTY-03', issue: 'backoff', severity: 'error', policy: { ...policy, backoff, jitter: randomize === true }, what, fix: edit ? { kind: 'auto', edits: [edit], note: `randomize: true multiplies each wait by a random 1 to 2; maxTimeout caps it. ${BACKOFF_NOTE}` } : guided([call], 'Wait between attempts: minTimeout above 0 with randomize: true and a maxTimeout.') });
    }
    if (lookup(opts, 'shouldRetry').absent) {
      const fn = fnOf(call.arguments[0]);
      const throws = fn ? statusThrows(fn, 0) : null;
      if (throws?.length && !/\bAbortError\b/.test(fn.getText())) issues.push({ rule: 'RTY-06', issue: 'status', severity: 'warning', policy, what: `the function it retries throws on every reply that is not ok, and p-retry retries every error but AbortError, so 400, 401 and 404 replies are sent again though they cannot succeed${/retry-after/i.test(fn.getText()) ? '' : ', and 429 and 503 are retried without reading Retry-After'}`, fix: guided(throws, 'Throw p-retry\'s AbortError for 4xx replies other than 408 and 429 (or pass shouldRetry), so only network errors, 429 and 5xx are retried; honour Retry-After on 429 and 503.') });
    }
    return issues;
  }

  // ---- got ----

  function gotRetry(call, retryNode) {
    const r = evalObject(cx, retryNode);
    if (r.entries.some((e) => e.open)) { stats.skipped.unreadable++; return []; }
    const get = (k, d) => { const v = lookup(r, k); return v.absent ? d : numberOf(v.value); };
    const limit = get('limit', 2), noise = get('noise', 100), backoffLimit = get('backoffLimit', Infinity);
    const policy = { retrier: 'got', attempts: limit === Infinity ? 'unbounded' : limit === null ? undefined : limit + 1 };
    const issues = [];
    const custom = !lookup(r, 'calculateDelay').absent;
    if (limit === Infinity) issues.push({ rule: 'RTY-01', issue: 'attempts', severity: 'error', policy, what: 'retry.limit is Infinity, so a failing service is called for as long as the request lasts, each wait twice the last', fix: { kind: 'auto', edits: [replaceNode(fileOf(call), unwrap(lookup(r, 'limit').value), String(RETRIES))], note: `limit: ${RETRIES} is got's default and three attempts in all, Google's limit (RTY-01).` } });
    if (!custom && noise === 0 && limit !== 0) issues.push({ rule: 'RTY-03', issue: 'backoff', severity: 'error', policy: { ...policy, backoff: 'exponential', jitter: false }, what: 'retry.noise is 0, so got\'s waits are exactly 1 s, 2 s, 4 s: every client that failed together retries together', fix: { kind: 'auto', edits: [replaceNode(fileOf(call), unwrap(lookup(r, 'noise').value), '100')], note: 'noise: 100 is got\'s default: up to 100 ms of jitter on each wait.' } });
    else if (!custom && Number.isFinite(limit) && backoffLimit === Infinity && 1000 * 2 ** (limit - 1) > LONG_WAIT_MS) issues.push({ rule: 'RTY-03', issue: 'backoff', severity: 'error', policy: { ...policy, backoff: 'exponential', jitter: true }, what: `retry.limit ${limit} with no backoffLimit, so the last wait is ${fmt(1000 * 2 ** (limit - 1))}`, fix: { kind: 'auto', edits: [insertProperty(fileOf(call), retryNode, 'backoffLimit: 10_000')], note: BACKOFF_NOTE } });
    const codes = lookup(r, 'statusCodes');
    const arr = !codes.absent && unwrap(codes.value);
    if (arr && ts.isArrayLiteralExpression(arr)) {
      const bad = arr.elements.map((e) => numberOf(e)).filter((c) => c !== null && c >= 400 && c < 500 && ![408, 413, 429].includes(c));
      if (bad.length) issues.push({ rule: 'RTY-06', issue: 'status', severity: 'warning', policy, what: `retry.statusCodes includes ${bad.join(', ')}, replies that cannot succeed when sent again`, fix: guided([codes.value], 'Keep 4xx out of statusCodes, except 408, 413 and 429.') });
    }
    return issues;
  }
  function isGot(o) {
    if (o.k === 'import' && o.module === 'got') return true;
    if (o.k === 'member' && o.base.k === 'got-instance') return true;
    return o.k === 'got-instance';
  }

  // ---- Hand-written loops ----

  function loop(node) {
    const body = node.statement;
    const outbound = [];
    within(body, node, (n) => { if (ts.isCallExpression(n) && isOutbound(n, 0)) outbound.push(n); });
    if (!outbound.length) return null;
    // The retry shape: leave on success, go round on failure.
    let shape = null, tryStmt = null, okIf = null;
    within(body, node, (n) => {
      if (shape) return;
      if (ts.isTryStatement(n) && n.catchClause && outbound.some((c) => inside(c, n.tryBlock)) && leaves(n.tryBlock, node) && !alwaysLeaves(n.catchClause.block)) { shape = 'catch'; tryStmt = n; }
      else if (ts.isIfStatement(n) && successTest(n.expression) && leaves(n.thenStatement, node) && !n.elseStatement) { shape = 'ok'; okIf = n; }
    });
    if (!shape) return null;

    const counters = counterSymbols(node);
    const issues = [];
    const capped = attemptCap(node, counters);
    const failLines = shape === 'catch' ? [tryStmt.catchClause] : [okIf];
    loopMeta.set(node, { capped, failLines });
    if (capped === false) issues.push({ rule: 'RTY-01', issue: 'attempts', severity: 'error', policy: { retrier: 'loop', attempts: 'unbounded' }, what: 'it has no limit on attempts, so a failing service is called for as long as the request lasts', fix: guided([node, ...failLines], 'Count attempts and give up after 3 (RTY-01), throwing the last error.') });
    const attempts = typeof capped === 'number' ? capped : undefined;

    const delays = [];
    within(body, node, (n) => { if (ts.isAwaitExpression(n)) { const d = delayArg(unwrap(n.expression)); if (d !== undefined) delays.push({ call: unwrap(n.expression), arg: d }); } });
    const policy = { retrier: 'loop', ...(attempts ? { attempts } : capped === false ? { attempts: 'unbounded' } : {}) };
    if (!delays.length) {
      issues.push({ rule: 'RTY-03', issue: 'backoff', severity: 'error', policy: { ...policy, backoff: 'none', jitter: false }, what: 'it retries at once, with no wait between attempts', fix: guided(failLines, `Wait before the next attempt: Math.random() * Math.min(${CAP_MS}, 100 * 2 ** attempt) ms (full jitter, RTY-03).`) });
    } else if (delays.length === 1 && delays[0].arg) {
      const { arg } = delays[0];
      const s = delayShape(arg, counters, node);
      const counterName = counterNames(node)[0];
      if (s.backoff !== 'unknown' && !(s.backoff === 'exponential' && s.jitter)) {
        const base = s.backoff === 'fixed' && s.value !== null ? arg.getText() : '100';
        const text = s.backoff === 'exponential' ? (s.cap ? `Math.random() * (${arg.getText()})` : `Math.random() * Math.min(${CAP_MS.toLocaleString('en-US').replace(/,/g, '_')}, ${arg.getText()})`)
          : counterName ? `Math.random() * Math.min(${CAP_MS.toLocaleString('en-US').replace(/,/g, '_')}, ${base} * 2 ** ${counterName})` : null;
        const grows = s.backoff === 'exponential' || s.backoff === 'linear';
        issues.push({
          rule: 'RTY-03', issue: 'backoff', severity: s.jitter ? 'warning' : 'error', policy: { ...policy, backoff: s.backoff, jitter: s.jitter },
          what: `it ${describeWait(s, arg)}${s.jitter ? '' : ', so every client that failed together retries together'}${grows || s.jitter ? '' : ', and does not back off as failures continue'}`,
          fix: text ? { kind: 'auto', edits: [replaceNode(fileOf(arg), arg, text)], note: BACKOFF_NOTE } : guided([delays[0].call], `Wait Math.random() * Math.min(${CAP_MS}, base * 2 ** attempt) ms (full jitter, RTY-03).`),
        });
      }
    }
    const all = retriesEverything(node, shape, tryStmt, okIf, outbound);
    if (all) issues.push({ rule: 'RTY-06', issue: 'status', severity: 'warning', policy, what: `${all.why}, so 400, 401 and 404 replies are sent again though they cannot succeed${/retry-after/i.test(enclosingFn(node)?.getText() ?? '') ? '' : ', and 429 and 503 are retried without reading Retry-After'}`, fix: guided(all.lines, 'Give up at once on 4xx replies other than 408 and 429; retry network errors, 429 and 5xx, honouring Retry-After.') });
    return issues;
  }
  // Whether the loop retries every failed reply: { why, lines } or null.
  function retriesEverything(node, shape, tryStmt, okIf, outbound) {
    if (shape === 'ok') {
      let statusExit = false;
      within(node.statement, node, (n) => { if (ts.isIfStatement(n) && n !== okIf && /\.status(Code)?\b/.test(n.expression.getText()) && leavesOrThrows(n.thenStatement)) statusExit = true; });
      return statusExit ? null : { why: 'it goes round again on every reply that is not ok', lines: [okIf] };
    }
    const catchText = tryStmt.catchClause.block.getText();
    if (/\b(status|statusCode|response|code|instanceof|retryable|isRetry)/i.test(catchText)) return null;
    const direct = outbound.filter((c) => inside(c, tryStmt.tryBlock) && throwsOnStatus(c));
    const thrown = [];
    within(tryStmt.tryBlock, node, (n) => { if (ts.isThrowStatement(n) && notOkGuard(n)) thrown.push(n); });
    if (!direct.length && !thrown.length) return null;
    return { why: `its catch retries every error, and ${direct.length ? `${clientName(direct[0])} throws on any 4xx or 5xx reply` : 'the call throws on any reply that is not ok'}`, lines: [tryStmt.catchClause] };
  }

  // ---- Reading code ----

  // Visits n's descendants that run in the loop's own iterations: not in
  // nested functions.
  function within(n, loopNode, fn) {
    const visit = (x) => { if (ts.isFunctionLike(x)) return; fn(x); ts.forEachChild(x, visit); };
    visit(n);
  }
  function inside(n, outer) { for (let p = n; p; p = p.parent) if (p === outer) return true; return false; }
  // A return, or a break of this loop, somewhere in n.
  function leaves(n, loopNode) {
    let found = false;
    const visit = (x, nested) => {
      if (found || ts.isFunctionLike(x)) return;
      if (ts.isReturnStatement(x)) found = true;
      if (ts.isBreakStatement(x) && !x.label && !nested) found = true;
      const inner = nested || ts.isIterationStatement(x, false) || ts.isSwitchStatement(x);
      ts.forEachChild(x, (c) => visit(c, inner));
    };
    visit(n, false);
    return found;
  }
  function leavesOrThrows(n) { let f = false; const v = (x) => { if (ts.isReturnStatement(x) || ts.isThrowStatement(x) || ts.isBreakStatement(x)) f = true; if (!ts.isFunctionLike(x)) ts.forEachChild(x, v); }; v(n); return f; }
  // A block whose last statement always leaves the loop.
  function alwaysLeaves(block) {
    const last = block.statements.at(-1);
    return !!last && (ts.isThrowStatement(last) || ts.isReturnStatement(last) || ts.isBreakStatement(last));
  }
  // res.ok, or a status comparison, alone or joined with &&.
  function successTest(e) {
    e = unwrap(e);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return successTest(e.left) && successTest(e.right);
    if (ts.isPropertyAccessExpression(e) && e.name.text === 'ok') return true;
    if (ts.isBinaryExpression(e) && ts.isPropertyAccessExpression(unwrap(e.left)) && ['status', 'statusCode'].includes(unwrap(e.left).name.text) && numberOf(e.right) !== null) return numberOf(e.right) < 400;
    return false;
  }
  // A throw guarded by !res.ok (or an else of res.ok).
  function notOkGuard(t) {
    for (let p = t.parent; p && !ts.isFunctionLike(p); p = p.parent) {
      if (ts.isIfStatement(p)) {
        const c = unwrap(p.expression);
        if (ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken && ts.isPropertyAccessExpression(unwrap(c.operand)) && unwrap(c.operand).name.text === 'ok') return true;
        return false;
      }
    }
    return false;
  }
  // The throws on !res.ok, or the axios/got calls, in a retried function.
  function statusThrows(fn, depth) {
    const out = [];
    const visit = (n) => {
      if (ts.isThrowStatement(n) && notOkGuard(n)) out.push(n);
      if (ts.isCallExpression(n) && throwsOnStatus(n)) out.push(n);
      else if (ts.isCallExpression(n) && depth < 1) { const f = functionOf(cx, n.expression); if (f?.body && f !== fn) out.push(...statusThrows(f, depth + 1)); }
      if (!ts.isFunctionLike(n) || n === fn) ts.forEachChild(n, visit);
    };
    visit(fn.body ?? fn);
    return out;
  }
  function clientOrigin(call) {
    let o = origin(cx, call.expression);
    while (o.k === 'member') o = o.base;
    return o;
  }
  function throwsOnStatus(call) {
    const o = clientOrigin(call);
    return (o.k === 'import' && THROWS_ON_STATUS.has(o.module)) || o.k === 'axios-instance' || o.k === 'got-instance';
  }
  function clientName(call) { const o = clientOrigin(call); return o.k === 'import' ? o.module : o.k === 'axios-instance' ? 'axios' : 'got'; }
  function isOutbound(call, depth) {
    const o = clientOrigin(call);
    if (o.k === 'global' && o.name === 'fetch') return true;
    if (o.k === 'import' && OUTBOUND.has(o.module)) return true;
    if (o.k === 'axios-instance' || o.k === 'got-instance') return true;
    if (depth >= MAX_FN_DEPTH) return false;
    const fn = functionOf(cx, call.expression);
    if (!fn?.body) return false;
    let found = false;
    const visit = (n) => { if (found) return; if (ts.isCallExpression(n) && isOutbound(n, depth + 1)) found = true; ts.forEachChild(n, visit); };
    visit(fn.body);
    return found;
  }
  // The wait an awaited expression stands for: its ms expression, null for
  // a wait whose length is not passed, undefined when it is not a wait.
  function delayArg(e) {
    if (!e) return undefined;
    if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Promise') {
      let ms;
      const visit = (n) => { if (ms === undefined && ts.isCallExpression(n) && isGlobal(origin(cx, n.expression), 'setTimeout') ) ms = n.arguments[1] ?? null; ts.forEachChild(n, visit); };
      e.arguments?.forEach(visit);
      return ms;
    }
    if (!ts.isCallExpression(e)) return undefined;
    const o = origin(cx, e.expression);
    if (o.k === 'import' && ['node:timers/promises', 'timers/promises'].includes(o.module) && o.path.at(-1) === 'setTimeout') return e.arguments[0] ?? null;
    if (o.k === 'import' && SLEEP_MODULES.has(o.module)) return e.arguments[0] ?? null;
    const fn = functionOf(cx, e.expression);
    if (fn?.body && /\bsetTimeout\s*\(/.test(fn.body.getText())) return e.arguments[0] ?? null;
    if (ts.isIdentifier(e.expression) && /^(sleep|delay|wait|pause|backoff)$/i.test(e.expression.text) && (!fn)) return e.arguments[0] ?? null;
    return undefined;
  }
  // { backoff: fixed|linear|exponential|unknown, jitter, cap, value }
  function delayShape(e, counters, loopNode) {
    const s = { random: false, exp: false, counter: false, cap: false };
    const seen = new Set();
    const visit = (n, depth) => {
      if (!n || seen.has(n) || depth > MAX_FN_DEPTH) return;
      seen.add(n);
      if (ts.isCallExpression(n)) {
        const o = origin(cx, n.expression);
        if (isGlobal(o, 'Math', 'random')) s.random = true;
        if (isGlobal(o, 'Math', 'pow')) s.exp = true;
        if (isGlobal(o, 'Math', 'min')) s.cap = true;
        const fn = !o.k?.startsWith('global') ? functionOf(cx, n.expression) : null;
        if (fn?.body) visit(fn.body, depth + 1);
      }
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.LessThanLessThanToken].includes(n.operatorToken.kind)) s.exp = true;
      if (ts.isIdentifier(n)) {
        const sym = cx.checker.getSymbolAtLocation(n);
        if (sym && counters.includes(sym)) s.counter = true;
        const d = declOf(cx, n)?.decl;
        if (d && ts.isVariableDeclaration(d) && d.initializer) visit(d.initializer, depth + 1);
        if (d && loopNode && sym && grownIn(sym, loopNode)) s.exp = true;
      }
      ts.forEachChild(n, (c) => visit(c, depth));
    };
    visit(e, 0);
    const value = numberOf(e);
    const backoff = s.exp ? 'exponential' : s.counter ? 'linear' : value !== null || (s.random && !s.counter) ? 'fixed' : 'unknown';
    return { backoff, jitter: s.random, cap: s.cap, value };
  }
  // delay *= 2, or delay = delay * 2, in the loop.
  function grownIn(sym, loopNode) {
    let grown = false;
    within(loopNode.statement, loopNode, (n) => {
      if (!ts.isBinaryExpression(n) || !ts.isIdentifier(n.left) || cx.checker.getSymbolAtLocation(n.left) !== sym) return;
      if (n.operatorToken.kind === ts.SyntaxKind.AsteriskEqualsToken || (n.operatorToken.kind === ts.SyntaxKind.EqualsToken && /\*/.test(n.right.getText()))) grown = true;
    });
    return grown;
  }
  function describeWait(s, e) {
    const t = e.getText();
    if (s.backoff === 'fixed') return `waits the same ${s.value !== null ? fmt(s.value) : t} every time${s.jitter ? ', randomised' : ''}`;
    if (s.backoff === 'linear') return `waits ${t}, which grows by the same step each time${s.jitter ? '' : ' with no randomness'}`;
    return `waits ${t}, doubling with no randomness`;
  }
  // The loop's counters: a for's own variables, or a variable incremented
  // in the loop.
  function counterSymbols(node) {
    const out = [];
    if (ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer)) for (const d of node.initializer.declarations) if (ts.isIdentifier(d.name)) out.push(cx.checker.getSymbolAtLocation(d.name));
    within(node, node, (n) => {
      const target = ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n) ? ([ts.SyntaxKind.PlusPlusToken].includes(n.operator) ? n.operand : null)
        : ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? n.left : null;
      if (target && ts.isIdentifier(target)) { const s = cx.checker.getSymbolAtLocation(target); if (s && !out.includes(s)) out.push(s); }
    });
    return out;
  }
  function counterNames(node) {
    const names = [];
    if (ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer)) for (const d of node.initializer.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
    within(node.statement, node, (n) => { if ((ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) && n.operator === ts.SyntaxKind.PlusPlusToken && ts.isIdentifier(n.operand)) names.push(n.operand.text); });
    return names;
  }
  // The number of attempts (a number), true when capped by something ERLANG
  // cannot count, or false when nothing caps it.
  function attemptCap(node, counters) {
    const refs = (e) => { let r = false; const v = (n) => { if (ts.isIdentifier(n) && counters.includes(cx.checker.getSymbolAtLocation(n))) r = true; ts.forEachChild(n, v); }; v(e); return r; };
    const cond = ts.isForStatement(node) ? node.condition : node.expression;
    const start = ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer) ? numberOf(node.initializer.declarations[0]?.initializer) ?? 0 : 0;
    let n = null;
    const bound = (c) => {
      c = unwrap(c);
      if (!c || !ts.isBinaryExpression(c)) return null;
      const k = c.operatorToken.kind;
      const v = numberOf(c.right) ?? numberOf(c.left);
      if (v === null) return null;
      if (k === ts.SyntaxKind.LessThanToken) return v - start;
      if (k === ts.SyntaxKind.LessThanEqualsToken || k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.GreaterThanEqualsToken || k === ts.SyntaxKind.EqualsEqualsToken) return v - start + 1;
      return v - start;
    };
    const comparisons = (c) => { c = unwrap(c); if (ts.isBinaryExpression(c) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(c.operatorToken.kind)) return [...comparisons(c.left), ...comparisons(c.right)]; return [c]; };
    const literalTrue = !cond || cond.kind === ts.SyntaxKind.TrueKeyword;
    if (!literalTrue) {
      if (!refs(cond)) return true; // while (!done): capped by something else, not judged
      for (const c of comparisons(cond)) if (refs(c)) n = bound(c) ?? n;
      return n ?? true;
    }
    let capped = false;
    within(node.statement, node, (x) => {
      if (ts.isIfStatement(x) && refs(x.expression) && leavesOrThrows(x.thenStatement)) { capped = true; for (const c of comparisons(x.expression)) if (refs(c)) n = bound(c) ?? n; }
    });
    return capped ? n ?? true : false;
  }

  function numberOf(e, depth = 0) {
    e = unwrap(e);
    if (!e || depth > 3) return null;
    if (ts.isNumericLiteral(e)) return Number(e.text.replaceAll('_', ''));
    if (ts.isIdentifier(e) && e.text === 'Infinity' && !declOf(cx, e)) return Infinity;
    if (ts.isPropertyAccessExpression(e) && e.getText() === 'Number.POSITIVE_INFINITY') return Infinity;
    if (ts.isIdentifier(e)) { const d = declOf(cx, e)?.decl; if (d && ts.isVariableDeclaration(d) && d.initializer && (d.parent.flags & ts.NodeFlags.Const)) return numberOf(d.initializer, depth + 1); }
    return null;
  }
  function returnsTrue(v) {
    const fn = unwrap(v);
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
    const rets = ts.isBlock(fn.body) ? returnsOf(fn.body) : [fn.body];
    return rets.length > 0 && rets.every((r) => unwrap(r)?.kind === ts.SyntaxKind.TrueKeyword);
  }
  function returnsOf(block) { const out = []; const v = (n) => { if (ts.isFunctionLike(n)) return; if (ts.isReturnStatement(n) && n.expression) out.push(n.expression); ts.forEachChild(n, v); }; v(block); return out; }
  function fnOf(e) { e = unwrap(e); if (!e) return null; if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e; return functionOf(cx, e); }
  function enclosingFn(n) { for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p; return null; }
  function fmt(ms) { return ms >= 1000 ? `${+(ms / 1000).toFixed(1)} s` : `${ms} ms`; }

  // Where a site's retries run: the call or loop, or for a configured
  // client (axiosRetry(client), const c = got.extend(...)), where it is used.
  function reachOf(s) {
    const direct = H.reach(s.node);
    if (direct.length) return direct;
    const target = s.kind === 'axios-retry' ? unwrap(s.node.arguments[0]) : s.kind === 'got' && ts.isVariableDeclaration(s.node.parent) ? s.node.parent.name : null;
    if (!target || !ts.isIdentifier(target)) return direct;
    if (isLib(origin(cx, target), 'axios')) {
      // The module's own default instance: every call on it, in any file.
      const out = [];
      for (const rel of rels) {
        const visit = (n) => {
          if (ts.isCallExpression(n) && clientOrigin(n).k === 'import' && clientOrigin(n).module === 'axios') for (const h of H.reach(n)) if (!out.includes(h)) out.push(h);
          ts.forEachChild(n, visit);
        };
        visit(cx.sourceFile(rel));
      }
      return out;
    }
    const sym = symOf(target);
    const out = [];
    for (const rel of rels) {
      const visit = (n) => {
        if (ts.isIdentifier(n) && n !== target && symOf(n) === sym) for (const h of H.reach(n)) if (!out.includes(h)) out.push(h);
        ts.forEachChild(n, visit);
      };
      visit(cx.sourceFile(rel));
    }
    return out;
  }
  function symOf(id) { const s = cx.checker.getSymbolAtLocation(id); return s && s.flags & ts.SymbolFlags.Alias ? cx.checker.getAliasedSymbol(s) : s; }

  // ---- Findings ----

  function fileOf(node) { return relOf(node.getSourceFile().fileName); }
  function locationOf(node) {
    const p = position(node);
    const symbol = symbolAt(node);
    return { file: fileOf(node), line: p.line, column: p.column, ...(symbol ? { symbol } : {}) };
  }
  function guided(nodes, note) {
    const seen = new Set();
    const locations = [];
    for (const n of nodes) {
      const sf = n.getSourceFile();
      const from = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      const to = ts.isCatchClause(n) ? sf.getLineAndCharacterOfPosition(n.block.getEnd()).line + 1 : ts.isIterationStatement(n, false) ? from : from;
      for (let l = from; l <= to; l++) { const k = `${fileOf(n)}:${l}`; if (!seen.has(k)) { seen.add(k); locations.push({ file: fileOf(n), line: l }); } }
    }
    return { kind: 'guided', locations, note };
  }
  function report(s, i, reach) {
    const loc = locationOf(s.node);
    const endpoints = [...new Set(reach.map((h) => h.label))];
    const at = endpoints.length ? `, on the path of ${endpoints.join(' and ')}` : '';
    const how = s.kind === 'loop' ? 'a retry loop' : s.kind === 'got' ? 'got\'s retry option' : s.kind;
    const subject = s.kind === 'axios-retry' ? `axios-retry on ${s.node.arguments[0]?.getText() ?? 'axios'}` : `${loc.symbol ?? 'Module code'} retries with ${how}`;
    let severity = i.severity;
    let message = `${subject}${at}: ${i.what}.`;
    const unsure = !H.handlers.length;
    if (unsure) { severity = 'info'; message += ' Unknown: ERLANG found no request handler, so whether a request waits on this is unknown (name entry points under handlers in erlang.config.json).'; }
    const eps = [];
    for (const h of reach) if (h.endpoint && !eps.some((x) => x.method === h.endpoint.method && x.route === h.endpoint.route)) eps.push(h.endpoint);
    const policy = Object.fromEntries(Object.entries(i.policy).filter(([, v]) => v !== undefined));
    findings.push({ check: i.check ?? CHECK, severity, message, rules: [i.rule], locations: [loc, ...(i.also ?? [])], endpoints: eps, keyParts: [`${loc.file}#${loc.symbol ?? '<module>'}`, s.kind, i.issue], extension: { strength: i.strength ?? STRENGTH, ...policy, ...(unsure ? { unresolved: true } : {}), fix: i.fix } });
  }

  // ---- Retries at several layers (RTY-02) ----

  function attemptsOf(s) {
    const plus = (v) => (v === null ? undefined : v === Infinity ? 'unbounded' : v + 1);
    if (s.kind === 'axios-retry') { const r = lookup(evalObject(cx, unwrap(s.node.arguments[1])), 'retries'); return r.open ? undefined : plus(r.absent ? 3 : numberOf(r.value)); }
    if (s.kind === 'p-retry') { const r = lookup(evalObject(cx, unwrap(s.node.arguments[1])), 'retries'); return r.open ? undefined : plus(r.absent ? 10 : numberOf(r.value)); }
    if (s.kind === 'got') { const r = lookup(evalObject(cx, s.retry), 'limit'); return r.open ? undefined : plus(r.absent ? 2 : numberOf(r.value)); }
    const c = loopMeta.get(s.node)?.capped;
    return typeof c === 'number' ? c : c === false ? 'unbounded' : undefined;
  }
  const baseOf = (e) => { e = unwrap(e); while (e && (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e) || ts.isElementAccessExpression(e))) e = unwrap(e.expression); return e && ts.isIdentifier(e) ? e : null; };
  // Whether an outbound call retries on its own: { how, attempts, site } or null.
  function retrierOfCall(call) {
    const o = origin(cx, call.expression);
    const base = clientOrigin(call);
    if (isGot(o) || base.k === 'got-instance') {
      const own = retriers.find((r) => r.kind === 'got' && r.node === call);
      if (own) { const a = attemptsOf(own); return a === 1 ? null : { how: "got's retry option", attempts: a, site: call }; }
      for (let b = base; b?.k === 'got-instance'; b = b.parent) for (const opt of b.options ?? []) {
        const r = lookup(evalObject(cx, opt), 'retry');
        if (r.absent) continue;
        if (r.open) return null;
        const l = lookup(evalObject(cx, unwrap(r.value)), 'limit');
        if (!l.absent && numberOf(l.value) === 0) return null;
      }
      const c = unwrap(call.expression);
      let method = ts.isPropertyAccessExpression(c) && ['get', 'post', 'put', 'patch', 'delete', 'head'].includes(c.name.text) ? c.name.text.toUpperCase() : null;
      for (const a of call.arguments) { const m = lookup(evalObject(cx, a), 'method'); if (!m.absent && !m.open && ts.isStringLiteralLike(unwrap(m.value))) method = unwrap(m.value).text.toUpperCase(); }
      method ??= 'GET';
      return GOT_RETRY_METHODS.has(method) ? { how: `got's default retry, 2 retries for ${method}`, attempts: 3, site: call } : null;
    }
    if (base.k === 'axios-instance' || (base.k === 'import' && base.module === 'axios')) {
      for (const a of call.arguments) {
        const r = lookup(evalObject(cx, a), 'axios-retry');
        if (!r.absent && !r.open) { const n = lookup(evalObject(cx, unwrap(r.value)), 'retries'); if (!n.absent && numberOf(n.value) === 0) return null; }
      }
      const id = baseOf(call.expression);
      for (const r of retriers) {
        if (r.kind !== 'axios-retry') continue;
        const target = unwrap(r.node.arguments[0]);
        const both = isLib(origin(cx, target), 'axios') ? base.k === 'import' : id && ts.isIdentifier(target) && symOf(id) === symOf(target);
        if (both) { const a = attemptsOf(r); return a === 1 ? null : { how: `axios-retry on ${target.getText()}`, attempts: a, site: r.node }; }
      }
    }
    return null;
  }
  // The first retry inside what an outer retry repeats: { what, how,
  // attempts, node } or null. Follows project functions MAX_FN_DEPTH deep.
  function innerRetry(region, outer, depth, seen) {
    let found = null;
    const visit = (n) => {
      if (found) return;
      const nested = retriers.find((r) => r.node === n && r.node !== outer && (r.kind === 'loop' || r.kind === 'p-retry'));
      if (nested) { found = { how: nested.kind === 'loop' ? 'a retry loop' : 'p-retry', attempts: attemptsOf(nested), node: nested.node }; return; }
      if (ts.isCallExpression(n)) {
        const own = retrierOfCall(n);
        if (own) { found = { ...own, node: n }; return; }
        const fn = depth < MAX_FN_DEPTH ? functionOf(cx, n.expression) : null;
        if (fn?.body && !seen.has(fn)) {
          seen.add(fn);
          const deeper = innerRetry(fn.body, outer, depth + 1, seen);
          if (deeper) { found = { ...deeper, via: n }; return; }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(region);
    return found;
  }
  for (const s of retriers) {
    if (s.kind !== 'loop' && s.kind !== 'p-retry') continue;
    perFile(gaps, fileOf(s.node), () => {
      const region = s.kind === 'loop' ? s.node.statement : fnOf(s.node.arguments[0]);
      if (!region) return;
      const inner = innerRetry(region, s.node, 0, new Set());
      if (!inner) return;
      stats.layered = (stats.layered ?? 0) + 1;
      const reach = reachOf(s);
      if (H.handlers.length && !reach.length) { stats.skipped.outsideRequests++; return; }
      const outer = attemptsOf(s);
      const total = typeof outer === 'number' && typeof inner.attempts === 'number' ? outer * inner.attempts : outer === 'unbounded' || inner.attempts === 'unbounded' ? 'unbounded' : undefined;
      const call = (inner.via ?? inner.node).getText().replace(/\s+/g, ' ');
      const callText = call.length > 60 ? `${call.slice(0, 57)}...` : call;
      report(s, {
        rule: 'RTY-02', issue: 'layers', severity: 'error', policy: { retrier: s.kind, ...(total !== undefined ? { attempts: total } : {}) },
        what: `it repeats ${callText}, which already retries on its own (${inner.how}${typeof inner.attempts === 'number' ? `, ${inner.attempts} attempts` : ''})${typeof total === 'number' ? `: one failure becomes up to ${total} calls to the service, and every layer above multiplies it again` : ', so the attempts multiply'}`,
        also: [locationOf(inner.node)],
        fix: guided([s.node, inner.node], LAYERS_NOTE),
      }, reach);
    });
  }

  // ---- Retry budgets (RTY-05, check retry-budget) ----

  // Whether an identifier names state kept across requests: a module-level
  // variable, not a function or a client, that is a let or var or has a
  // method called on it here.
  function isState(id) {
    const d = declOf(cx, id)?.decl;
    if (!d || !ts.isVariableDeclaration(d) || !ts.isVariableStatement(d.parent?.parent) || !ts.isSourceFile(d.parent.parent.parent)) return false;
    const init = unwrap(d.initializer);
    if (init && ts.isFunctionLike(init)) return false;
    const o = init ? origin(cx, init) : null;
    if (o && (o.k === 'axios-instance' || o.k === 'got-instance' || (o.k === 'import' && OUTBOUND.has(o.module)))) return false;
    const p = id.parent;
    const method = ts.isPropertyAccessExpression(p) && p.expression === id && ts.isCallExpression(p.parent) && p.parent.expression === p;
    return !(d.parent.flags & ts.NodeFlags.Const) || method;
  }
  function consultsBudget(nodes) {
    let found = false;
    const visit = (n) => { if (found) return; if (ts.isIdentifier(n) && isState(n)) { found = true; return; } ts.forEachChild(n, visit); };
    for (const n of nodes) if (n) visit(n);
    return found;
  }
  // Where a retrier decides to retry, as nodes.
  function decisionOf(s) {
    const fnBody = (v) => { if (!v) return null; const f = fnOf(v); return f ?? v; };
    if (s.kind === 'axios-retry') { const r = lookup(evalObject(cx, unwrap(s.node.arguments[1])), 'retryCondition'); return r.absent || r.open ? [] : [fnBody(r.value)]; }
    if (s.kind === 'p-retry') { const o = evalObject(cx, unwrap(s.node.arguments[1])); return ['shouldRetry', 'onFailedAttempt'].map((k) => lookup(o, k)).filter((r) => !r.absent && !r.open).map((r) => fnBody(r.value)); }
    if (s.kind === 'got') { const r = lookup(evalObject(cx, s.retry), 'calculateDelay'); return r.absent || r.open ? [] : [fnBody(r.value)]; }
    const m = loopMeta.get(s.node);
    return [ts.isForStatement(s.node) ? s.node.condition : s.node.expression, ...(m?.failLines ?? [])];
  }
  const afterImports = (node) => {
    const sf = node.getSourceFile();
    const imports = sf.statements.filter(ts.isImportDeclaration);
    return imports.length ? sf.getLineAndCharacterOfPosition(imports.at(-1).end).line + 2 : 1;
  };
  for (const s of retriers) {
    perFile(gaps, fileOf(s.node), () => {
      const attempts = attemptsOf(s);
      if (attempts === 1) return;
      if (consultsBudget(decisionOf(s))) { stats.budgeted = (stats.budgeted ?? 0) + 1; return; }
      const reach = reachOf(s);
      if (H.handlers.length && !reach.length) return;
      // Where the retry is decided: a loop's failure branch, or the options
      // object that takes retryCondition, shouldRetry or calculateDelay.
      const where = s.kind === 'loop' ? loopMeta.get(s.node).failLines : s.kind === 'got' ? [s.retry] : [unwrap(s.node.arguments[1]) ?? s.node];
      const fix = guided(where, BUDGET_NOTE);
      const first = afterImports(s.node);
      if (!fix.locations.some((l) => l.line === first)) fix.locations.unshift({ file: fileOf(s.node), line: first });
      report(s, {
        check: 'retry-budget', rule: 'RTY-05', issue: 'budget', severity: 'warning', strength: 'SHOULD', policy: { retrier: s.kind, ...(attempts !== undefined ? { attempts } : {}) },
        what: `nothing across requests limits how often it retries. While the service fails, every request retries${typeof attempts === 'number' ? `, ${attempts} attempts each,` : ','} so the load on the failing service grows with the load offered instead of staying near it. A process-wide retry budget (Google retries only while retries are under 10% of requests) caps that (RTY-05)`,
        fix,
      }, reach);
    });
  }

  const counts = new Map();
  const out = findings.map((f) => {
    const base = fingerprint(f.check, ...f.keyParts);
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    return finding({
      specialist: 'erlang',
      check: f.check,
      severity: f.severity,
      fingerprint: n === 1 ? base : `${base}|${n}`,
      message: f.message,
      detection: ['static'],
      rules: f.rules,
      where: { locations: f.locations, ...(f.endpoints.length ? { endpoints: f.endpoints } : {}) },
      extension: f.extension,
    });
  });
  return { findings: out, run: stats, incomplete: gaps };
}
