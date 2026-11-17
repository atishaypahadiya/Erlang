// report/1: one run of one specialist on one subject, and its findings.
//
// Pinned to the released contract: core/schema/report.schema.json is a copy
// of ITTEN's schema/report.schema.json at the release tag v0.3.5. See
// core/schema/README.md.
//
// Shared code: nothing here imports from a specialist.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { validate, register } from './schema.js';
import { findingSchema } from './finding.js';

export const SCHEMA = 'report/1';
export const reportSchema = register(JSON.parse(readFileSync(new URL('./schema/report.schema.json', import.meta.url), 'utf8')));

// Validates a report/1, findings included. Returns a list of errors.
export const check = (r) => validate(reportSchema, r);

// Builds a report/1 and validates it. `run` is the specialist's own run data,
// kept beside the core fields under the specialist's name. Throws on any error.
export function report({ specialist, version, status = 'complete', reason, subject, started = new Date(), findings = [], run }) {
  const r = {
    schema: SCHEMA,
    specialist,
    version,
    status,
    ...(reason ? { reason } : {}),
    ...(subject ? { subject } : {}),
    started: (started instanceof Date ? started : new Date(started)).toISOString().replace(/\.\d+Z$/, 'Z'),
    findings: status === 'refused' ? [] : findings,
    ...(run ? { [specialist]: run } : {}),
  };
  const errors = check(r);
  if (errors.length) throw new Error(`not a valid report/1: ${errors.join('; ')}`);
  return r;
}

export function write(path, r) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(r, null, 2) + '\n');
}

export const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

export { findingSchema };
