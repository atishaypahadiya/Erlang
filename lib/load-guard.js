// The load harness's guard (research/load-harness.md). Load against a
// service someone else runs is a denial-of-service attack, so the target is
// only ever a twin the harness started on the loopback interface; there is no
// switch that widens it. Rates and durations are capped per step and per run:
// tighter on a workstation than in CI, where the full suite runs.

export class Refused extends Error {}

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

export const CAPS = {
  // CI: the full suite, one form per runner.
  ci: { rate: 500, stepSeconds: 60, runSeconds: 1200, maxVUs: 1000, forms: Infinity },
  // CI, a form that runs alone in its own job (ERLANG_LOAD_PROFILE=ci-long,
  // L05, whose heap slopes need 30 s steps): the same rate and step caps, a
  // longer run, so the form does not run at the cap.
  'ci-long': { rate: 500, stepSeconds: 60, runSeconds: 2400, maxVUs: 1000, forms: 1 },
  // A workstation: one form per run, at modest rates (the owner allowed
  // local load runs on 19 November 2026, against ERLANG's own fixtures on
  // 127.0.0.1, never while ITTEN holds its timing lock).
  local: { rate: 200, stepSeconds: 20, runSeconds: 600, maxVUs: 400, forms: 1 },
};

export const profile = (env = process.env) => (env.CI === 'true' ? (env.ERLANG_LOAD_PROFILE === 'ci-long' ? 'ci-long' : 'ci') : 'local');

// A URL the harness is about to load: loopback, http, a port, nothing else.
export function checkTarget(url) {
  let u;
  try { u = new URL(url); } catch { throw new Refused(`not a URL: ${url}`); }
  if (u.protocol !== 'http:') throw new Refused(`only plain http to a twin on loopback is loaded, not ${u.protocol}`);
  if (!LOOPBACK.has(u.hostname)) throw new Refused(`${u.hostname} is not the loopback interface; ERLANG loads only twins it started on 127.0.0.1`);
  if (!u.port) throw new Refused(`no port in ${url}`);
  return u;
}

// One step of a load.json: a rate and a duration within the caps.
export function checkStep(step, caps) {
  const rate = Number(step.rate);
  const seconds = Number(step.seconds);
  if (!(rate > 0) || !(seconds > 0)) throw new Refused(`step ${step.id}: rate and seconds must be positive`);
  if (rate > caps.rate) throw new Refused(`step ${step.id}: ${rate} requests a second is over the cap of ${caps.rate}`);
  if (seconds > caps.stepSeconds) throw new Refused(`step ${step.id}: ${seconds} s is over the cap of ${caps.stepSeconds} s a step`);
  return { rate, seconds };
}

// A whole form: every step, every repeat, both twins, within the run's cap.
export function checkRun(spec, caps) {
  const repeats = spec.repeats ?? 3;
  const seconds = 2 * repeats * (spec.steps ?? []).reduce((s, st) => s + checkStep(st, caps).seconds, 0);
  if (seconds > caps.runSeconds) throw new Refused(`${spec.fixture}: ${seconds} s of load in all is over the cap of ${caps.runSeconds} s`);
  return seconds;
}
