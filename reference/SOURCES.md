# Sources

All sources were accessed on 17 November 2026. **Checked** means the bibliographic details and every quotation used in the rules were confirmed against the source's own text or its publisher's record (for paywalled papers, the DOI registry's Crossref record). **Secondary** means the source itself could not be read; what is cited of it rests on the reputable page named in the notes.

## Queueing and scalability

| ID | Source | Status | Notes |
|---|---|---|---|
| S1 | J. D. C. Little. "A Proof for the Queuing Formula: L = λW." *Operations Research* 9(3):383–387, 1961. https://doi.org/10.1287/opre.9.3.383 | Checked (abstract, via Crossref) | L = λW under stationarity and finite means. The formula was in use before; this is its first general proof. |
| S2 | J. D. C. Little. "OR FORUM—Little's Law as Viewed on Its 50th Anniversary." *Operations Research* 59(3):536–549, 2011. https://doi.org/10.1287/opre.1110.0940 | Checked (via Crossref) | Retrospective. |
| S3 | J. D. C. Little and S. C. Graves. "Little's Law." In *Building Intuition: Insights from Basic Operations Management Models and Principles*, Springer, 2008, pp. 81–100. https://doi.org/10.1007/978-0-387-73699-0_5 | Checked | The finite-window form: exact when the window starts and ends empty and no arrivals are lost. Page numbers of quotations taken from a scan of the published chapter. |
| S4 | A. K. Erlang. "The Theory of Probabilities and Telephone Conversations." *Nyt Tidsskrift for Matematik* B, vol. 20, 1909. | Secondary (S6, S7) | Random calls follow the Poisson distribution. Page range not confirmed, so not given. |
| S5 | A. K. Erlang. "Solution of some Problems in the Theory of Probabilities of Significance in Automatic Telephone Exchanges." *Elektroteknikeren*, vol. 13, 1917. | Secondary (S6, S7) | The loss and waiting-time formulas. Page range not confirmed. |
| S6 | J. J. O'Connor and E. F. Robertson. "Agner Krarup Erlang." MacTutor History of Mathematics, University of St Andrews. https://mathshistory.st-andrews.ac.uk/Biographies/Erlang/ | Checked | Source of the quotations about S4 and S5. |
| S7 | Plus Magazine. "Agner Krarup Erlang (1878–1929)." University of Cambridge, 1997. https://plus.maths.org/content/agner-krarup-erlang-1878-1929 | Checked | Titles, journals and years of S4 and S5. |
| S8 | N. J. Gunther. "A Simple Capacity Model of Massively Parallel Transaction Systems." *Proc. CMG Conference*, San Diego, December 1993, pp. 1035–1044. | Secondary (Gunther's own reference lists in S10 and on S11) | Origin of the model. Gunther's sources disagree on "of" and "for" in the title. |
| S9 | N. J. Gunther. *Guerrilla Capacity Planning*. Springer, 2007. ISBN 978-3-540-26138-4. https://doi.org/10.1007/978-3-540-31010-5 | Checked (via Crossref) | Book-length treatment of the USL. |
| S10 | N. J. Gunther. "A General Theory of Computational Scalability Based on Rational Functions." arXiv:0808.1431, 2008. https://arxiv.org/abs/0808.1431 | Checked | USL in σ, κ notation (eq. 5), its maximum (eq. 6), retrograde throughput, and why Amdahl's law cannot show it. |
| S11 | N. J. Gunther. "How to Quantify Scalability." Performance Dynamics. http://www.perfdynamics.com/Manifesto/USLscalability.html | Checked (read through a fetch tool; the site refuses direct downloads) | USL in α, β notation and N* = √((1 − α)/β). Not quoted; the same results are quoted from S10. |
| S26 | R. Jain. "Analysis of a Single Queue." CSE 567 lecture slides, Washington University in St. Louis, 2017. https://classes.engineering.wustl.edu/~jain/cse567-17/ftp/k_31asq.pdf | Checked | M/M/1 mean response time (1/μ)/(1 − ρ), slide 31-15. |
| S27 | MIT OpenCourseWare. 2.854 *Introduction to Manufacturing Systems*, Fall 2016, "M/M/1 Queue" note. https://ocw.mit.edu/courses/2-854-introduction-to-manufacturing-systems-fall-2016/927056a1af54772a587fd84ad4951e71_MIT2_854F16_Mm1Queue.pdf | Checked | Stability needs λ < μ; Ws = 1/(μ − λ). |

## Measurement

| ID | Source | Status | Notes |
|---|---|---|---|
| S12 | B. Gregg. "The USE Method." https://www.brendangregg.com/usemethod.html | Checked | Utilisation, saturation, errors for every resource; definitions; interpretation. |
| S13 | B. Gregg. "Thinking Methodically about Performance." *ACM Queue* 10(12):40–51, 2012, https://doi.org/10.1145/2405116.2413037; also *Communications of the ACM* 56(2):45–51, 2013, https://doi.org/10.1145/2408776.2408791 | Checked (via Crossref) | Published form of the USE method. Quotations are from S12. |
| S14 | T. Wilkie. "The RED Method: key metrics for microservices architecture." Weaveworks blog, 13 May 2017. Archived: https://web.archive.org/web/20171118020450/https://www.weave.works/blog/the-red-method-key-metrics-for-microservices-architecture/ | Checked (archived copy) | Rate, errors, duration as a distribution; based on Google's golden signals; request-driven services only. Often misdated to 2018. |
| S15 | T. Wilkie. "The RED Method: Patterns for instrumentation & monitoring." GrafanaCon EU 2018, slides. https://grafana.com/files/grafanacon_eu_2018/Tom_Wilkie_GrafanaCon_EU_2018.pdf | Checked | "For every service". |
| S28 | Grafana Labs. "Open and closed models." k6 documentation. https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/ | Checked | Names coordinated omission; arrival-rate executors. |
| S29 | G. Tene. wrk2 README. https://github.com/giltene/wrk2 | Checked | Constant-throughput load; latency measured from intended send time; HdrHistogram. |

## Overload, retries and timeouts

The Google chapters are from the 2016 first edition of *Site Reliability Engineering: How Google Runs Production Systems*, ed. B. Beyer, C. Jones, J. Petoff and N. R. Murphy, O'Reilly, 2016, ISBN 978-1-4919-2912-4, published online under CC BY-NC-ND 4.0. A rewritten edition now exists; its chapter numbers differ.

| ID | Source | Status | Notes |
|---|---|---|---|
| S16 | R. Ewaschuk. "Monitoring Distributed Systems." Ch. 6 of *Site Reliability Engineering* (2016). https://sre.google/sre-book/monitoring-distributed-systems/ | Checked | The four golden signals; error latency; p99 over short windows; utilisation targets. |
| S17 | A. Forero Cuervo. "Handling Overload." Ch. 21 of *Site Reliability Engineering* (2016). https://sre.google/sre-book/handling-overload/ | Checked | Per-customer limits, client-side throttling (formula printed as an image), criticality, three attempts per request, 10% retry ratio, retry one layer up, serving the provisioned rate under excess load. |
| S18 | M. Ulrich. "Addressing Cascading Failures." Ch. 22 of *Site Reliability Engineering* (2016). https://sre.google/sre-book/addressing-cascading-failures/ | Checked | Queue sizing, 503 load shedding, LIFO and CoDel, backoff, retry budgets, 64-attempt example, deadlines and their propagation, cancellation, cold caches, health checks, testing until failure. |
| S19 | M. Brooker. "Timeouts, retries, and backoff with jitter." Amazon Builders' Library, 2019. https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/ (now redirects to builder.aws.com) | Checked | Connection and request timeouts, timeouts from p99.9, 243× amplification, retry at one point, token-bucket retry limits, idempotency, jitter. The page prints the author as "Marc" with profile alias mbrooker; the surname is from S20's link to it. |
| S20 | M. Brooker. "Exponential Backoff And Jitter." AWS Architecture Blog, 4 March 2015, updated May 2023. https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/ | Checked | Full, equal and decorrelated jitter. Results are from a simulation of write contention, not production measurement. Formulas are printed as images. |
| S21 | D. Yanacek. "Using load shedding to avoid overload." Amazon Builders' Library, 2019. https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/ | Checked | Goodput; testing far past the breaking point; failed-request latency kept out of latency metrics; queue time bounds; spillover; deadlines between hops; pagination. Author shown as "David", alias dyanacek. |
| S22 | D. Yanacek. "Avoiding insurmountable queue backlogs." Amazon Builders' Library, 2019. https://aws.amazon.com/builders-library/avoiding-insurmountable-queue-backlogs/ | Checked | Recovery from backlogs, message age, per-workload thread pools, backpressure, a Little's-law example. |

## Stability patterns

| ID | Source | Status | Notes |
|---|---|---|---|
| S23 | M. T. Nygard. *Release It! Design and Deploy Production-Ready Software*, 2nd ed. Pragmatic Bookshelf, 2018. ISBN 978-1-68050-239-8. https://pragprog.com/titles/mnee2/release-it-second-edition/ | Checked: contents and the publisher's free excerpt of ch. 4 (https://media.pragprog.com/titles/mnee2/antipatterns.pdf) | Pattern and antipattern names are from the contents. Quotations are from the excerpt only. The patterns chapter was not read, so no rule quotes it. |
| S24 | M. Fowler. "CircuitBreaker." 6 March 2014. https://martinfowler.com/bliki/CircuitBreaker.html | Checked | Closed, open and half-open states; credits Nygard. |
| S25 | Microsoft. "Bulkhead pattern." Azure Architecture Center, revised 19 March 2026. https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead | Checked | Description of bulkheads. The current page does not cite Nygard. |

## Empirical studies

| ID | Source | Status | Notes |
|---|---|---|---|
| S30 | J. Yang, P. Subramaniam, S. Lu, C. Yan and A. Cheung. "How Not to Structure Your Database-Backed Web Applications: A Study of Performance Bugs in the Wild." *ICSE 2018*. https://doi.org/10.1145/3180155.3180194 | Checked | Twelve Rails applications, 204 performance issues. Showing all records on one page is the most common cause of scalability problems (15 of 34 actions); missing indexes are the most common category in bug trackers; N+1, eager loading, redundant queries. |
| S31 | T.-H. Chen, W. Shang, Z. M. Jiang, A. E. Hassan, M. Nasser and P. Flora. "Detecting Performance Anti-patterns for Applications Developed Using Object-Relational Mapping." *ICSE 2014*, pp. 1001–1012. https://doi.org/10.1145/2568225.2568259 | Checked | One-by-one processing and excessive data in Java ORM applications; static detection; response time improved by up to 98%, 35% on average. |
| S32 | G. Jin, L. Song, X. Shi, J. Scherpelz and S. Lu. "Understanding and Detecting Real-World Performance Bugs." *PLDI 2012*, pp. 77–88. https://doi.org/10.1145/2254064.2254075 | Checked | 109 performance bugs in general software, not web applications. Two thirds need large inputs; a quarter are unnecessary work; a third are efficient calls combined inefficiently. |
| S34 | F. Majerík. "Revisiting ORM Performance Anti-Patterns in LLM-Generated Data Access Code: Replication Artifact." Zenodo, 2026. https://doi.org/10.5281/zenodo.23846799 | Checked (the artifact's result files; the paper, accepted at Informatics 2026, was not available) | 900 single-shot generations against PostgreSQL. Supporting evidence only: no rule rests on it alone. Its detector misses about 40% of what human reviewers flag, so its rates are lower bounds. |

## Platform documentation

| ID | Source | Status | Notes |
|---|---|---|---|
| S35 | node-postgres. "Pooling." https://node-postgres.com/features/pooling | Checked (its source, docs/pages/features/pooling.mdx in brianc/node-postgres) | Clients must be returned on every path, errors included. |
| S36 | node-postgres. "pg.Pool." https://node-postgres.com/apis/pool | Checked (docs/pages/apis/pool.mdx) | Waiting in a FIFO queue when every client is checked out; what an unreleased client does. |
| S37 | Node.js. "Don't Block the Event Loop (or the Worker Pool)." Node.js Learn. https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop | Checked | What blocking is, the synchronous APIs a server should not use (the list is "reasonably complete as of Node.js v9"), and the denial-of-service risk. |
| S38 | bcrypt (node.bcrypt.js). README, "Why is async mode recommended over sync mode?" https://github.com/kelektiv/node.bcrypt.js | Checked | The sync API blocks the event loop; the async API uses a thread pool. bcryptjs, the pure-JavaScript port, splits its asynchronous work into chunks instead (its README, https://github.com/dcodeIO/bcrypt.js). |
| S39 | Microsoft. "Chatty I/O antipattern." Azure Architecture Center. https://learn.microsoft.com/en-us/azure/architecture/antipatterns/chatty-io/ | Checked (accessed 19 November 2026) | A logical operation made as many small HTTP requests or queries; the fix is fewer, larger requests. |
| S40 | AWS. "Best practices for working with AWS Lambda functions." AWS Lambda Developer Guide. https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html | Checked (accessed 19 November 2026) | Initialise clients and connections outside the handler, so later invocations reuse them. |
| S41 | Kubernetes. "Configure Liveness, Readiness and Startup Probes." https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/ | Checked (accessed 19 November 2026) | Readiness probes keep requests away while an application loads large data or configuration at startup. |
| S33 | MDN Web Docs. "Compression in HTTP." https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Compression | Checked | Up to 70% size reduction; what not to compress; `Vary: Accept-Encoding`. |

Further studies used by the failure model are listed in `research/failure-model.md`.
