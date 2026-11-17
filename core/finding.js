// finding/1: the finding format every specialist in the set writes.
//
// Pinned to the released contract: core/schema/finding.schema.json is a copy
// of ITTEN's schema/finding.schema.json at the release tag v0.3.5. When the
// contract changes, copy it again from the new tag (see
// core/schema/README.md) and rerun the tests.
//
// Shared code: nothing here imports from a specialist, so core/ can be lifted
// out as it is. A specialist passes its name and its own fields; the core
// fields are checked against the schema and the extension is left to the
// specialist's own schema.

import { readFileSync } from 'node:fs';
import { validate, register } from './schema.js';

export const SCHEMA = 'finding/1';
export const findingSchema = register(JSON.parse(readFileSync(new URL('./schema/finding.schema.json', import.meta.url), 'utf8')));

// The fingerprint by the schema's convention: the check, then the parts of
// where that identify the finding, joined by |.
export const fingerprint = (check, ...parts) => [check, ...parts].join('|');

// Builds a finding/1 and validates it. `forbidden` lists values that must not
// appear anywhere in the finding, extension included: the raw values the check
// read (secrets, tokens), so a slip in a message or an extension field fails
// loudly instead of being written to a report. Throws on any error.
export function finding({ specialist, check, severity, fingerprint: fp, message, measured = [], floor = null, detection, rules, where, extension }, { forbidden = [] } = {}) {
  const f = {
    schema: SCHEMA,
    specialist, check, severity,
    fingerprint: fp,
    message,
    measured,
    floor,
    detection,
    ...(rules?.length ? { rules } : {}),
    where,
    ...(extension ? { [specialist]: extension } : {}),
  };
  const errors = validate(findingSchema, f);
  if (errors.length) throw new Error(`not a valid finding/1: ${errors.join('; ')}`);
  const leaked = leaks(f, forbidden);
  if (leaked.length) throw new Error(`finding ${fp} would carry secret material (${leaked.length} value(s)); no field may hold a secret or a hash of one`);
  return f;
}

// The forbidden values found anywhere in obj's JSON. Values shorter than
// eight characters are ignored: "true", "1" or "dev" cannot be told apart
// from ordinary text, and no credential worth the name is that short.
export const MIN_SECRET_LENGTH = 8;
export function leaks(obj, forbidden) {
  const text = JSON.stringify(obj);
  return forbidden.filter((v) => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH && text.includes(JSON.stringify(v).slice(1, -1)));
}
