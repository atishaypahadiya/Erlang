# What ERLANG needs from finding/1

> **Superseded in part.** finding/1 and report/1 were released at ITTEN's `v0.3.5`, and ERLANG uses them through a pinned copy of KERCKHOFFS's `core/`. The release settled several points below:
> - `where` takes `elements`, `locations`, `endpoints` and `resources` together;
> - `rules` is in the core;
> - a core `detection` field (`render`, `static`, `config`, `trace`, `live`, `load`) carries the evidence proposed here as `evidence`;
> - report/1 has the statuses `complete`, `partial` and `refused`.
>
> The rest stays as a record of what was asked.

ERLANG's requirements on the shared finding format, split into what the core must carry (because the gate, the board or another specialist reads it) and what stays in ERLANG's own `erlang` object. Written against the uncommitted draft in ITTEN's `finding1` worktree (`schema/finding.schema.json` and `schema/finding-itten.schema.json`), read on 17 November 2026. Nothing here changes ITTEN; it is a list to take there.

## What the draft has

Required core fields: `schema`, `specialist`, `check`, `severity` (error, warning, info), `fingerprint`, `message`, `measured` (paths of fields that differ between runs of the same subject), `floor` (security, accessibility or null) and `where`. `where` is exactly one of `elements` (CSS selectors), `location` (`file`, `line`) or `endpoint` (`method`, `route`). Any other top-level key must be an object named after a specialist and is not validated by the core. ITTEN's extension carries `id`, `count`, `seen`, `first`, `title`, `rule` and `crops`.

## What works for ERLANG as it is

- `specialist: "erlang"`, `check` with ERLANG's check names (`n-plus-one`, `retry-storm`, …), `severity`, `message`.
- `floor: null`. No ERLANG check holds a security or accessibility floor. Where ERLANG and KERCKHOFFS meet (rate limits against load shedding), KERCKHOFFS's floor wins, as the core intends.
- `measured`, unchanged in principle. Every latency, rate, percentile, duration and memory figure from a load or trace run is a measured field. Counts that ERLANG can make deterministic (statements per request, rows returned, attempts per request, bytes per response) are not, so parity compares them exactly. Percentile keys need names that start with a letter to fit the path pattern (`p50`, `p99`, `p999`, not `99.9`); ERLANG will name them so.
- The extension mechanism: an `erlang` object, validated by ERLANG's own schema.

## Core changes ERLANG needs

### 1. Which kind of evidence a finding rests on

ERLANG's main difference from other tools is that one finding can rest on several kinds of evidence: a loop in the source, 51 statements of one shape in a trace, statements growing tenfold as the page grows tenfold. The gate and the board need to read this without opening the extension: a static-only finding is cheaper to trust and fix than a load-only one, and a load-only finding that comes and goes needs different handling.

**Proposal.** A required core field, an array of one or more values from a shared enum, sorted, without duplicates:

| Value | Meaning | Used by |
|---|---|---|
| `static` | Read from source, configuration or migrations, without running anything | ERLANG, KERCKHOFFS, ITTEN's lint step |
| `render` | Measured in a browser on a rendered page | ITTEN |
| `trace` | Read from telemetry of a run at low rate: spans, query logs, process metrics | ERLANG |
| `load` | Measured under generated load | ERLANG |
| `probe` | Measured by sending requests to a running deployment | KERCKHOFFS |

**Name.** Your note calls it `mode`. ITTEN's extension already uses "mode" for something else: `seen` is keyed "per mode (light, dark, 200% text, an engine, a resize)". To keep one word for one idea across the set, ERLANG proposes calling the core field **`evidence`**. If ITTEN's word stays as it is, `mode` is fine and `seen`'s description should change.

**Compatibility.** The draft's root `additionalProperties` admits only objects, so this cannot be added by a specialist; it must be in the core. The draft is uncommitted, so making it required now costs nothing. Later it would be finding/2.

**Fingerprint.** `evidence` is not part of the fingerprint. The same defect first seen statically and later confirmed by a trace is one finding, with its evidence growing.

### 2. A finding on an endpoint and in code at once

Most ERLANG findings have two places: where the defect shows (an endpoint) and where it is fixed (one or more places in code). An N+1 shows on `GET /orders` and is fixed in the handler's loop and, often, in a serializer in another file. The draft's `oneOf` allows exactly one shape.

**Proposal.**

- `where` holds one or more of `elements`, `locations` and `endpoint`, with at least one present. ITTEN keeps sending `elements` alone; nothing changes for it.
- `location` becomes `locations`, an array, matching `elements`. A defect's fix can span files.
- Each location gains optional `symbol` (the function or method, such as `listOrders`), `endLine` and `column`. ERLANG's fingerprint uses `file` and `symbol`, not `line`, so a finding keeps its fingerprint when unrelated edits move it down a file.

### 3. The endpoint shape

- **`route` is a route template, not a URL**: `/users/:id/events`, never `/users/42/events`. Otherwise every id makes a new fingerprint. State this in the schema's description.
- **Optional `service`**: the name of the service, for repositories that hold more than one (and for ERLANG's fixtures, which hold many).
- **Optional `protocol`**, defaulting to `http`: `http`, `grpc`, `queue` or `job`. For `queue`, `route` is the queue or topic; for `job`, the job's name. `method` is required only when `protocol` is `http`. Queue consumers and scheduled jobs are where backlogs and retry storms live (OVL-10, MEA-10).
- **A service-wide shape**: some findings belong to no single endpoint. Goodput falling past the knee (CAP-02), a pool exhausted by several routes, memory growing with uptime. Proposal: `where.service` as a fourth option, `{ "name": "api" }`, used alone.

### 4. Rules in the core

Every ERLANG finding cites the rules it breaks (`DAT-01`, `TMO-01`), and so does ITTEN, in its extension's `rule` string. A gate that merges three specialists' findings should be able to show "why" without knowing each extension.

**Proposal.** An optional core `rules`: an array of rule IDs or external criteria (`DAT-01`, `WCAG 2.5.8`). ITTEN can keep `rule` in its extension or move it.

### 5. Findings whose presence depends on the run

A load finding can appear in one run and not the next, on the same code, when the service sits near a threshold. ITTEN met the same thing with contrast over a moving background and keeps a `movingBackground` marker in its extension, which its parity test reads. If the gate compares a pull request's findings with a baseline, it needs to know which findings may flicker, or it will report them as new and fixed on alternate pushes.

**Proposal.** An optional core flag, `unstable: true`, set by the specialist when a finding's presence has been seen to vary between runs of the same subject. The gate then judges it on repeated runs instead of one. ERLANG's own fixture test treats any unstable finding as a failure; in a user's project it is reported and judged, not hidden.

### 6. A home for the run

finding/1 describes one finding. ERLANG's findings mean little without their run: the target (and the proof that it was loopback or a CI container), the load profile, the rate and duration caps, the seeded data size, the k6 version, whether an ITTEN timing lock refused or interrupted a step. These are per run, not per finding.

**Question for ITTEN.** Does the core define a report envelope (say `report/1`: specialist, version, run id, start and end, subject, status, findings), or does each specialist keep its own report and the core only merge findings? ERLANG needs a run status the gate can read, at least `complete`, `refused` (a timing lock or the loopback guard stopped the run) and `interrupted`, so a refused run is never mistaken for a clean one.

## The `erlang` extension

Validated by ERLANG's own schema, as ITTEN's is by `finding-itten.schema.json`. Proposed fields:

| Field | Type | Measured? | Meaning |
|---|---|---|---|
| `id` | string, `e001`… | no | The finding's id in this report, in order first seen. Not stable between runs; use the fingerprint. |
| `title` | string | no | Short title. |
| `static` | object | no | `pattern`: what was matched (for example `query-in-loop`). `unresolved`: true when the check could not tell (a timeout set in configuration it cannot read), so the finding is `info`, not a defect. |
| `statements` | array | no | For data-access findings: each statement shape (normalised, literals removed), its count per request, rows returned per call. |
| `scale` | object | no | The scaling comparison: `metric` (statements, rows, bytes), `varied` (what was scaled: `data` for 1× and 10× seeded rows, or `pageSize`), and `low` and `high`, each the value of what was varied and the metric there. Counts, so not measured. |
| `upstream` | object | no | Attempts the upstream stub or dependency received per user request, and the gaps between them. |
| `load` | object | partly | `profile`: model (always `open`), rate, duration, data scale (not measured; these are the inputs). Results: `rateRps`, `goodputRps`, `errorRatio`, `latencyMs.success` and `latencyMs.error`, each with `p50`, `p90`, `p99`, `p999` and `n` (measured). |
| `capacity` | object | yes | Where measured: the knee, and the Universal Scalability Law fit (`alpha`, `beta`, `nStar`) with the range of concurrency it was fitted on (CAP-07). |
| `memory` | object | yes | Resident memory at the start and end of a soak, and its slope. |
| `artifacts` | array | no | Paths under `dist/` to the evidence: the trace, the k6 summary, the `EXPLAIN` output, the statement log. The equivalent of ITTEN's crops. |

`severity` follows the rule's strength: a MUST rule broken is `error`, a SHOULD is `warning`, a MAY is `info`. A static finding marked `unresolved` is `info` whatever the rule.

## Example

An N+1 finding as ERLANG would write it, with the proposed core changes (`evidence`, `rules`, `where` with `endpoint` and `locations`). Against the current draft it fails on `evidence` and `rules` (not objects at the root) and on `where` (two shapes).

```json
{
  "schema": "finding/1",
  "specialist": "erlang",
  "check": "n-plus-one",
  "severity": "error",
  "fingerprint": "n-plus-one|api|GET /orders|src/routes/orders.js#listOrders",
  "message": "GET /orders makes one query per order: 11 statements for a page of 10, 101 for a page of 100.",
  "measured": ["erlang.load.latencyMs.success.p50", "erlang.load.latencyMs.success.p99"],
  "floor": null,
  "evidence": ["load", "static", "trace"],
  "rules": ["DAT-01", "DAT-07"],
  "where": {
    "endpoint": { "service": "api", "method": "GET", "route": "/orders" },
    "locations": [{ "file": "src/routes/orders.js", "line": 42, "symbol": "listOrders" }]
  },
  "erlang": {
    "id": "e001",
    "title": "One query per order",
    "static": { "pattern": "query-in-loop" },
    "statements": [
      { "shape": "SELECT * FROM customers WHERE id = $1", "perRequest": 50, "rowsPerCall": 1 },
      { "shape": "SELECT * FROM orders ORDER BY created_at DESC LIMIT $1", "perRequest": 1, "rowsPerCall": 50 }
    ],
    "scale": { "metric": "statements", "varied": "pageSize", "low": { "at": 10, "value": 11 }, "high": { "at": 100, "value": 101 } },
    "load": {
      "profile": { "model": "open", "rateRps": 20, "durationS": 30, "dataScale": "1x" },
      "latencyMs": { "success": { "p50": 38, "p99": 112, "n": 600 } }
    },
    "artifacts": ["dist/runs/2026-11-17T1102/trace.json", "dist/runs/2026-11-17T1102/statements.log"]
  }
}
```

## Questions for ITTEN

1. `evidence` or `mode` for the core field, given `seen`'s use of "mode"?
2. Will `where` allow several shapes at once, and `location` become `locations`?
3. Optional core `rules`, or does each specialist keep its own?
4. Optional core `unstable`, or a per-specialist marker the gate learns to read?
5. A shared report envelope, or per-specialist reports with a status the gate can read?
6. Does the fingerprint format belong in the core's description (check, then the parts of `where`, joined by `|`), so the three specialists build fingerprints the same way?
