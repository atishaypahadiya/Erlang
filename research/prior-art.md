# Prior art

What existing tools already cover, so ERLANG builds only what is missing and reuses the rest. Checked against each tool's own documentation on 17 November 2026. No tool was installed or run.

## Summary

Three groups of tools each cover one kind of evidence well, and none spans all three:

- **Load generators** (k6, Gatling, Artillery, Locust, wrk2) produce synthetic load, and all but wrk2 can fail a CI job on thresholds. They measure the service from outside and say nothing about the code that made it slow.
- **APM and tracing products** (Datadog, Sentry, New Relic, Scout) already detect several of the defects in ERLANG's failure model from traces: N+1 queries, sequential calls, aggressive retries, dependency timeouts, missing indexes, memory bloat. They work on telemetry from a running, instrumented service, sent to the vendor's backend, after deployment.
- **Static rules** (Semgrep, Bandit, Ruff) catch single patterns, most clearly an HTTP call with no timeout in Python.

Lighthouse measures one page load in a browser and nothing about the server under concurrent requests; it belongs on ITTEN's side of the line.

A tool aimed at agent-written code already exists (VibeDoctor), and an APM vendor already feeds N+1 and memory findings to coding agents over MCP (Scout). So "performance checking for agent-written code" is not new, and ERLANG should not claim it is.

## Load generators

### k6

Grafana Labs, AGPL-3.0, scripts in JavaScript run by an embedded engine [P1]. It offers both workload models: arrival-rate executors (`constant-arrival-rate`, `ramping-arrival-rate`) start iterations on schedule whatever the service does, and the other executors are closed loops. Its documentation names the closed-loop problem, coordinated omission, and says to use the arrival-rate executors to avoid it [P2]. Thresholds on any metric make k6 exit with a non-zero code when they fail, which is its CI gate; checks alone do not gate unless a threshold is set on them [P3]. A browser module adds page-level metrics. A tracing module adds trace context headers to requests so a tracing backend can link them to the run; it does not analyse the traces [P4].

*Does not:* read source code, analyse traces, name a defect, or say which code is at fault.

### Gatling

Apache-2.0 community edition, with a commercial enterprise tier; simulations written in Java, Kotlin, Scala or JavaScript [P5]. Every injection profile must be either open (`constantUsersPerSec`) or closed (`constantConcurrentUsers`), never a mix, which makes the workload model an explicit choice [P6]. Assertions on global statistics fail the run: "If at least one assertion fails, the simulation fails" [P7].

*Does not:* use traces or source.

### Artillery

MPL-2.0 for most of the code. Scenarios in YAML or JavaScript, with load phases defined by arrival rate of new virtual users and an optional cap on concurrent users [P8][P9]. The `ensure` plugin exits non-zero when a metric misses its threshold [P10]. A Playwright engine runs real browsers and reports page metrics. Distributed runs execute from the user's own cloud account.

*Does not:* use traces or source.

### Locust

MIT, plain Python, with distributed master and worker processes [P11][P12]. Load is defined by a number of users and a spawn rate; a `LoadTestShape` class controls both over time, and a `constant_throughput` wait time paces each user [P12][P13]. The gate is an exit code: 1 if any request failed, or whatever a listener sets in `process_exit_code`, so thresholds are code the user writes, not configuration [P14].

*Does not:* use traces or source; has no declarative thresholds.

### wrk2

Gil Tene's fork of wrk, which holds a constant request rate and measures each request's latency from when it should have been sent, correcting for coordinated omission, with results in an HdrHistogram [P15]. The reference for measuring latency correctly under load.

*Does not:* gate CI, script scenarios beyond Lua hooks, or use traces or source.

## APM and tracing

### Datadog

APM Recommendations lists detectors including "N+1 Queries on Database", "Repeated Sequential API calls", "Persistent Retries", "Aggressive Retries", "Dependency Timeouts" and "Missing index", the last using Database Monitoring's explain plans [P16].

### Sentry

Detects performance issues from transaction spans, including N+1 Queries, Consecutive DB Queries, N+1 API Calls and Large HTTP Payload [P17]. Its N+1 detector looks for "sequential, non-overlapping database spans with similar descriptions", above a total duration (50 ms) and a span count (usually five), with full query text in the spans [P18]. This is the most precisely documented trace heuristic found, and a good starting point for ERLANG's trace check.

### New Relic

Performance Risks includes analysers for N+1 query, Sequential DB, Excessive DB and Slow SQL, and for large HTTP payloads in the browser [P19].

### Scout APM

An MCP server gives coding agents read-only access to insights that identify "N+1 queries, memory bloat, and slow queries" from recent traces [P20]. The closest existing tool to "performance findings for coding agents", but read-only and production-only: it reports, it does not hold work open.

### OpenTelemetry

Instrumentation and a data format, not a backend or a detector [P21]. Its database span conventions carry the query text (parameterised by default) and, optionally, the rows returned, which is enough for every trace check in ERLANG's failure model [F10]. ERLANG should read OpenTelemetry rather than define its own trace format.

*Common to all four products:* they need an instrumented service with real or staged traffic and a vendor backend. None generates load. Whether any can gate a pull request on a pre-merge run was not checked; if one can, ERLANG's "before merge" difference narrows. None treats a missing timeout as a property of the code: Datadog sees timeouts that fired, not calls that could hang.

## Static rules

Semgrep's `python.requests.best-practice.use-timeout` flags a `requests` call made without a timeout [P22], and Bandit's B113 checks `requests` and `httpx` calls the same way [F9]. No rule pack was found covering ORM N+1 patterns, unbounded queries, retries without jitter or blocking calls in handlers across languages; this was not searched exhaustively, and CodeQL's packs were not checked.

## Front end: Lighthouse

Lighthouse scores one page load in a lab browser. In Lighthouse 10 the score weights Total Blocking Time 30%, Largest Contentful Paint 25%, Cumulative Layout Shift 25%, First Contentful Paint 10% and Speed Index 10% [P23]. Lighthouse CI's `assert` command exits with a failing status when an assertion at `error` level fails [P24]. It measures the client, not the server under concurrent load. Page weight and front-end performance are ITTEN's to judge; ERLANG covers what the server does when many such pages are requested at once.

## Tools for agent-written code

VibeDoctor scans applications built with coding agents, runs inside the agent over MCP, and combines static analysis, secret detection, dependency scanning and Lighthouse on the live site [P25]. Its homepage covers security and front-end performance; it does not list server-side load defects. Scout's MCP server is above. Agent code-review products (CodeRabbit, Greptile, Qodo and others) were not checked and may comment on N+1 queries or missing timeouts in review.

## Coverage

Y documented, P partial, N not found in the documentation checked, ? not checked.

| Capability | k6 | Gatling | Artillery | Locust | wrk2 | Datadog | Sentry | New Relic | Scout MCP | Semgrep, Bandit | Lighthouse CI | VibeDoctor |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Generates load | Y | Y | Y | Y | Y | N | N | N | N | N | N | N |
| Open model, free of coordinated omission | Y | Y | Y | P | Y | N | N | N | N | N | N | N |
| Fails a CI job | Y | Y | Y | Y | N | ? | ? | ? | N | Y | Y | ? |
| Evidence from traces | P | N | ? | N | N | Y | Y | Y | Y | N | N | N |
| Evidence from source | N | N | N | N | N | N | N | N | N | Y | N | Y |
| N+1 queries | N | N | N | N | N | Y | Y | Y | Y | ? | N | N |
| Unbounded queries | N | N | N | N | N | N | N | N | N | ? | N | N |
| Missing index | N | N | N | N | N | Y | N | P | P | N | N | N |
| Missing timeout in code | N | N | N | N | N | P | N | N | N | Y (Python) | N | N |
| Retries without backoff | N | N | N | N | N | Y | N | N | N | ? | N | N |
| Pool exhaustion | N | N | N | N | N | N | N | N | N | N | N | N |
| Memory growth | N | N | N | N | N | ? | N | N | Y | N | N | N |
| Runs before merge without a vendor service | Y | Y | Y | Y | Y | N | N | N | N | Y | Y | N |
| Built for coding agents | N | N | N | N | N | ? | ? | ? | Y | N | N | Y |
| Holds work open until checks pass | N | N | N | N | N | N | N | N | N | N | N | N |
| One finding format with design and security checks | N | N | N | N | N | N | N | N | N | N | N | P |

New Relic's Slow SQL and Scout's slow queries are marked partial for missing indexes: they find the slow query, not the absent index. VibeDoctor is partial on the shared format because it puts security and front-end findings in one report, not a contract shared between separate checkers.

## The gap ERLANG fills

Not new, and not claimed: open-model load with CI thresholds; N+1, retry and timeout detection from production traces; performance findings delivered to agents over MCP; scanning agent-written code; a static missing-timeout rule.

What no tool found does:

1. **The supervisor loop.** brief → lint → inspect → gate → fix, shared with ITTEN: a piece of work stays open while any check fails, and findings go back to the agent that wrote the code, with the rule and the evidence. Every tool above reports; none holds the work. The generated-code study suggests this is where the leverage is, since stating a performance goal alone cut its most common defects by a half to four fifths [F4].
2. **Three kinds of evidence behind one finding, before merge, on the owner's machine or CI.** A static finding ("this loop queries per item") confirmed by a trace from a short local run ("51 statements of one shape under this request") and, where it matters, by local load ("statements per request grow tenfold with tenfold data"). APMs have the second, after deployment and through a vendor; load tools have the third, without the code; linters have the first, alone.
3. **Checks for the defects agents write that nothing else names.** Unbounded queries and connection-pool exhaustion have no detector in any tool checked. Missing timeouts are found statically only for Python's two most common HTTP clients.
4. **One gate with ITTEN and KERCKHOFFS.** Findings follow ITTEN's finding/1 contract, so one CI gate covers design, security and load, and a conflict between them is settled by the order the core sets: security floors, then accessibility floors, then craft.

## What to reuse rather than build

- **The load driver: k6, as a separate program.** k6's arrival-rate executors generate open-model load and avoid coordinated omission. ERLANG drives it rather than building a driver, and adds its own safety guard and output format on top (decision of 17 November 2026; see the licence boundary below).
- **Trace input.** OpenTelemetry spans and PostgreSQL's `pg_stat_statements`, not a format of ERLANG's own.
- **Trace heuristics.** Sentry's N+1 rule as the starting point for ERLANG's, tuned on the fixtures.
- **Static rules.** Bandit B113 and Semgrep's timeout rule for Python; ERLANG adds the languages and libraries they do not cover.

## Licence boundary with k6

k6 is licensed under the GNU Affero General Public License v3 [P1]. ERLANG keeps a clean separation from it:

- **Run, never ship.** ERLANG runs the `k6` executable that the user or CI installed, as a separate process. It does not vendor, bundle, download into the repository, modify, fork or link k6 code, and its packages do not depend on k6.
- **Talk through files and arguments.** ERLANG writes a k6 scenario at run time and passes it on the command line; k6 writes its results as JSON, which ERLANG reads. No k6 code runs inside ERLANG's process, and no ERLANG code is loaded into k6 beyond the generated scenario.
- **No k6 extensions.** ERLANG does not build or ship a custom k6 binary (xk6). A need for one is a reason to reconsider, not a step to take quietly.
- **Installation is the user's.** ERLANG checks that `k6` is on the path and stops with an install hint if it is not. CI installs it from Grafana's own release in a workflow step.

Running an unmodified AGPL program as a separate process and reading its output does not place ERLANG under the AGPL. This is a design rule, not legal advice; if ERLANG ever needs to change k6 or ship it, the licence question comes back before the code does.

## Sources

`[F*]` sources are listed in `failure-model.md`. All pages accessed 17 November 2026.

| ID | Source |
|---|---|
| P1 | Grafana Labs. k6 README. https://github.com/grafana/k6 |
| P2 | Grafana Labs. "Open and closed models." https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/ |
| P3 | Grafana Labs. "Thresholds." https://grafana.com/docs/k6/latest/using-k6/thresholds/ |
| P4 | Grafana Labs. k6 tracing module. https://grafana.com/docs/k6/latest/javascript-api/k6-experimental/tracing/ |
| P5 | Gatling README. https://github.com/gatling/gatling |
| P6 | Gatling. "Injection." https://docs.gatling.io/concepts/injection/ |
| P7 | Gatling. "Assertions." https://docs.gatling.io/concepts/assertions/ |
| P8 | Artillery README. https://github.com/artilleryio/artillery |
| P9 | Artillery. "Test script reference." https://www.artillery.io/docs/reference/test-script |
| P10 | Artillery. "ensure" plugin. https://www.artillery.io/docs/reference/extensions/ensure |
| P11 | Locust README. https://github.com/locustio/locust |
| P12 | Locust. "Configuration." https://docs.locust.io/en/stable/configuration.html |
| P13 | Locust. "Writing a locustfile." https://docs.locust.io/en/stable/writing-a-locustfile.html |
| P14 | Locust. "Running without the web UI." https://docs.locust.io/en/latest/running-without-web-ui.html |
| P15 | G. Tene. wrk2 README. https://github.com/giltene/wrk2 |
| P16 | Datadog. "APM Recommendations." https://docs.datadoghq.com/tracing/recommendations/ |
| P17 | Sentry. "Performance Issues." https://docs.sentry.io/product/issues/issue-details/performance-issues/ |
| P18 | Sentry. "N+1 Queries." https://docs.sentry.io/product/issues/issue-details/performance-issues/n-one-queries/ |
| P19 | New Relic. "Performance Risks." https://docs.newrelic.com/docs/errors-inbox/performance-risks/introduction/ |
| P20 | Scout APM. "MCP server." https://scoutapm.com/docs/ai/mcp/ |
| P21 | OpenTelemetry. "What is OpenTelemetry?" https://opentelemetry.io/docs/what-is-opentelemetry/ |
| P22 | Semgrep rules. `python.requests.best-practice.use-timeout`. https://github.com/semgrep/semgrep-rules/blob/develop/python/requests/best-practice/use-timeout.yaml |
| P23 | Chrome for Developers. "Lighthouse performance scoring." https://developer.chrome.com/docs/lighthouse/performance/performance-scoring |
| P24 | Lighthouse CI. "Configuration." https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md |
| P25 | VibeDoctor. https://vibedoctor.io/ |
