# Load and resilience rules

A reference set of rules for how a web service should behave under load, with the reasoning and evidence behind each rule. ERLANG's checks cite these rules, so a finding can say which rule it breaks and why the rule exists.

The set draws on queueing theory (Little, Erlang, Gunther), Google's Site Reliability Engineering book, the Amazon Builders' Library, Michael Nygard's *Release It!*, Brendan Gregg's USE method, Tom Wilkie's RED method, and empirical studies of performance bugs in database-backed applications. Every rule carries an identifier, a strength and an evidence level, so it can be cited in a review, checked by a tool, or overridden on purpose.

## How the set is organised

| File | Prefix | Question it answers |
|---|---|---|
| [rules/01-measurement.md](rules/01-measurement.md) | MEA | What must a load test measure, and how, for its numbers to mean anything? |
| [rules/02-capacity.md](rules/02-capacity.md) | CAP | How much can the service take, and what should happen past that point? |
| [rules/03-timeouts.md](rules/03-timeouts.md) | TMO | How long may any call wait? |
| [rules/04-retries.md](rules/04-retries.md) | RTY | When may a failed call be tried again, and how? |
| [rules/05-overload.md](rules/05-overload.md) | OVL | What does the service do with more work than it can serve? |
| [rules/06-stability.md](rules/06-stability.md) | STB | Which structures stop one failure spreading to the rest? |
| [rules/07-data-access.md](rules/07-data-access.md) | DAT | How does a request read and write data, and how much does it send back? |

Measurement comes first on purpose. A load test that measures the wrong thing (a closed loop that slows down with the server, a mean that hides the tail, fast errors counted as fast successes) produces a confident wrong answer, and every later rule depends on its numbers.

## Rule format

```
### TMO-01 · Every outbound call has a timeout
Strength: MUST · Evidence: practice · Check: static, trace, load
<rule>
*Why:* <reasoning, with a short quotation from the source>
Sources: [S19][S23]
```

**Strength** follows RFC 2119: **MUST** (violations are defects), **SHOULD** (deviate only with a recorded reason), **MAY** (an option worth considering).

**Evidence** states what kind of authority stands behind a rule. The vocabulary is shared by ITTEN, KERCKHOFFS and ERLANG, so a level means the same in every specialist's findings; each specialist uses the levels that apply to it.

| Level | Meaning | Changes when |
|---|---|---|
| `standard` | A normative requirement from a standards body (an RFC, a W3C recommendation). | A new version of the standard is published. |
| `platform` | The documented behaviour or convention of a platform, runtime or product, from its maker (Node.js, PostgreSQL, a browser, Apple's HIG). | The maker revises it. |
| `research` | A peer-reviewed empirical finding. | New evidence contradicts it. |
| `theory` | A theorem or analytic model. Holds exactly where its assumptions hold, and only approximately elsewhere. | Never, though its fit to a given service can be wrong. |
| `practice` | An industry write-up by a named organisation or author who ran the systems in question, including worked examples and simulations published with it. | The practice changes. |
| `craft` | Consensus or this repository's judgment, with no single documented source. | Practice changes. |
| `taste` | A stated preference of this repository's owner. | The owner changes their mind. |
| `observed` | Measured by the set's own tools, on its fixtures or the owner's services, with the run cited. | A later run measures otherwise. |

None of the sources on overload, retries and timeouts is peer-reviewed research. They are practice: what Google and Amazon do and why, written by the engineers who did it. The evidence column says so rather than borrow a stronger word.

**Check** names the kinds of evidence ERLANG can use for the rule: `static` (source and migrations), `trace` (spans, query logs and metrics from a short low-rate run), `load` (a local load run against the owner's own service), or `report` (a property of ERLANG's own output, not of the service). `research/failure-model.md` gives the detection method for each defect.

Numbers quoted from a source as an example ("e.g. 50% or less", "say, 60 retries per minute") are given as the source's example, not as thresholds the source endorses.

Rule identifiers are stable. A retired rule keeps its number and is marked retired.

## Scope and exclusions

The set covers request-driven web services and the queues and workers behind them, tested by their owner. It does not cover front-end performance in the browser, which belongs to ITTEN, or security, which belongs to KERCKHOFFS. Where a load rule meets a security rule (rate limits, for one), the security floor comes first.

Commonly repeated rules deliberately left out:

- **"Keep utilisation under 70%" as a universal limit.** Gregg's 70% applies to resources that cannot be interrupted mid-operation, such as disks, and he contrasts CPUs, which can be. The general rule kept here is headroom (CAP-05), not a single figure.
- **Erlang's 1909 paper as the source of the loss and waiting formulas.** The 1909 paper showed that randomly placed calls follow the Poisson distribution. The loss and waiting-time formulas came in 1917. Both are cited for what they contain (CAP-09, CAP-10).
- **A circuit breaker on every call as a MUST.** The sources disagree: Fowler describes the pattern Nygard popularised, and Brooker argues that breakers add modal behaviour that is hard to test and prefers a local retry budget. STB-03 is a MAY.
- **Amdahl's law alone to extrapolate capacity.** It cannot predict throughput falling as load rises, which real services show. CAP-07 uses the Universal Scalability Law instead.
- **Three retries as a universal count.** Google's chapters count three *attempts* in one place and three *retries* (four attempts) in another, and Amazon's 243× example multiplies three tries per layer. The rules here count attempts per request and treat three as Google's practice, not a law.

## Editions

The Google SRE book has been rewritten. Chapter numbers and quotations here are from the 2016 first edition, as published online at sre.google/sre-book/. The Amazon Builders' Library articles now redirect to builder.aws.com; the original URLs are given. *Release It!* is cited in its 2018 second edition.

## Sources

Every citation `[Sn]` resolves in [SOURCES.md](SOURCES.md). Sources are paraphrased; quotations are short and attributed. Consult the originals for the full argument.

## Licence

Text: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Attribution: Atishay Pahadiya.
