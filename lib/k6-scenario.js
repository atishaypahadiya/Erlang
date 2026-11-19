// The k6 script for one load step, written at run time (research/
// load-harness.md). k6 runs it as a separate program; nothing of k6 is
// vendored or linked. Open model: k6's constant-arrival-rate executor starts
// requests at a fixed rate whatever the service does, so a slow service
// builds a queue instead of slowing the test.
//
// Each response is counted as one of:
//   ok       a 2xx within okMs (goodput);
//   late     a 2xx after okMs;
//   refused  a 503 or 429 (shed load);
//   failed   any other status, or no response within timeoutMs.
// handleSummary writes k6's end-of-test summary, these counters and trends
// included, to the given file. A step with a background (another request at
// its own rate, such as a CPU-heavy route) runs it as a second scenario,
// counted apart: the counters above are the step's own requests only.

import { checkTarget } from './load-guard.js';

export function scenario({ base, step, summaryFile, vus }) {
  checkTarget(base);
  const url = new URL(step.path, base).href;
  const method = (step.method ?? 'GET').toUpperCase();
  const body = step.body === undefined ? null : JSON.stringify(step.body);
  const okMs = step.okMs ?? 500;
  const timeoutMs = step.timeoutMs ?? 10_000;
  const pre = Math.min(vus, Math.max(10, Math.ceil(step.rate * 0.2)));
  const bg = step.background ?? null;
  if (bg) checkTarget(new URL(bg.path, base).href);
  return `// Written by ERLANG's load harness for step ${JSON.stringify(step.id)}; not edited by hand.
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';

const ok = new Counter('erlang_ok');
const late = new Counter('erlang_late');
const refused = new Counter('erlang_refused');
const failed = new Counter('erlang_failed');
const servedMs = new Trend('erlang_served_ms', true);
const refusedMs = new Trend('erlang_refused_ms', true);

export const options = {
  scenarios: {
    step: { executor: 'constant-arrival-rate', rate: ${Number(step.rate)}, timeUnit: '1s', duration: '${Number(step.seconds)}s', preAllocatedVUs: ${pre}, maxVUs: ${Number(vus)} },${bg ? `
    background: { executor: 'constant-arrival-rate', exec: 'background', rate: ${Number(bg.rate)}, timeUnit: '1s', duration: '${Number(step.seconds)}s', preAllocatedVUs: ${Math.min(vus, Math.max(10, Math.ceil(bg.rate * 0.2)))}, maxVUs: ${Number(vus)} },` : ''}
  },
  summaryTrendStats: ['med', 'p(90)', 'p(99)', 'max', 'count'],
  discardResponseBodies: true,
  noConnectionReuse: false,
};

const URL_ = ${JSON.stringify(url)};
const BODY = ${JSON.stringify(body)};
const PARAMS = { timeout: '${Number(timeoutMs)}ms', headers: Object.assign(BODY === null ? {} : { 'content-type': 'application/json' }, ${JSON.stringify(step.metric === 'bytes' ? { 'accept-encoding': 'gzip, br' } : {})}), tags: { erlang: 'step' } };

export default function () {
  const i = String(exec.scenario.iterationInTest + 1);
  const r = http.request(${JSON.stringify(method)}, URL_.replaceAll('%24i', i).replaceAll('$i', i), BODY === null ? null : BODY.replaceAll('$i', i), PARAMS);
  if (r.status >= 200 && r.status < 300) {
    servedMs.add(r.timings.duration);
    if (r.timings.duration <= ${Number(okMs)}) ok.add(1); else late.add(1);
  } else if (r.status === 503 || r.status === 429) {
    refused.add(1);
    refusedMs.add(r.timings.duration);
  } else failed.add(1);
}

${bg ? `const BG_URL = ${JSON.stringify(new URL(bg.path, base).href)};
const BG_BODY = ${JSON.stringify(bg.body === undefined ? null : JSON.stringify(bg.body))};
export function background() {
  const i = String(exec.scenario.iterationInTest + 1);
  http.request(${JSON.stringify((bg.method ?? 'GET').toUpperCase())}, BG_URL, BG_BODY === null ? null : BG_BODY.replaceAll('$i', i), { timeout: '${Number(timeoutMs)}ms', headers: BG_BODY === null ? {} : { 'content-type': 'application/json' }, tags: { erlang: 'background' } });
}
` : ''}export function handleSummary(data) {
  return { ${JSON.stringify(summaryFile)}: JSON.stringify(data) };
}
`;
}
