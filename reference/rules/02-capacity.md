# Capacity

How much load a service can take, how to find out, and how it should behave beyond that point.

## Finding the limit

### CAP-01 · Load test each component until it breaks, and beyond
Strength: MUST · Evidence: practice · Check: load

Every service the owner runs has a measured breaking point, found by raising load until goodput stops rising, then continuing past it. Components with their own capacity (the database, a worker pool, a dependency the owner also runs) are tested separately, since each breaks at its own point.

*Why:* the SRE book puts this first among the defences against overload, "in rough priority order": "Load test the server's capacity limits, and test the failure mode for overload" [S18]. "Load test components until they break" [S18]. Amazon: a team that has not tested "to the point where it breaks, and far beyond the point where it breaks" should "assume that the service will fail in the least desirable way possible" [S21].

### CAP-02 · Past saturation, goodput levels off; it does not collapse
Strength: MUST · Evidence: practice · Check: load

As offered load rises past capacity, the service keeps serving roughly its capacity in good requests and refuses or degrades the rest. A service whose goodput falls as load rises past the knee fails this rule, however high the knee.

*Why:* three sources state the same test. Google: past the breaking point the component "should ideally start serving errors or degraded results in response to additional load, but not significantly reduce the rate at which it successfully handles requests" [S18]. Google again: a task should keep serving its provisioned rate "regardless of how much excess traffic is thrown at the task", up to "somewhere above 2x or even 10x" that rate [S17]. Amazon: "The ideal load test result is for goodput to plateau when the service is close to being fully utilized, and to remain flat even when more throughput is applied" [S21]. This is Erlang's main load oracle.

### CAP-03 · Test both a gradual ramp and a sudden step
Strength: SHOULD · Evidence: practice · Check: load

A service that survives a slow ramp can still fall over when the same load arrives at once, for instance while caches and connection pools fill.

*Why:* "consider testing both gradual and impulse load patterns" [S18].

### CAP-04 · Test recovery after overload
Strength: SHOULD · Evidence: practice · Check: load

After a run past the breaking point, load returns to normal and the service returns to normal goodput and latency without a restart. Record how far load had to fall for it to recover.

*Why:* "You should also test and understand how the component behaves as it returns to nominal load after having been pushed well beyond that load" [S18]. Recovery often needs load well below the level that caused the failure: a service that began crashing at 11,000 QPS will "almost certainly not" stop crashing if load drops to 9,000 [S18]. A queue-backed service has a backlog to clear: an hour-long outage needs "double the system's capacity for another hour" [S22].

### CAP-05 · Keep headroom on the bottleneck
Strength: SHOULD · Evidence: theory, practice · Check: load

Run the bottleneck resource well below full utilisation at expected peak, and report the headroom: the ratio of measured capacity to expected peak.

*Why:* in the simplest queue (M/M/1) the mean response time is S/(1 − ρ), where S is the service time and ρ the utilisation, so it doubles at half utilisation, is ten times S at 90% and grows without bound as ρ approaches 1 [S26]. Real services are not M/M/1, so the numbers are directional, but practice agrees: "many systems degrade in performance before they achieve 100% utilization, so having a utilization target is essential" [S16].

### CAP-06 · Above capacity there is no steady latency to report
Strength: MUST · Evidence: theory · Check: report

A queue is stable only while the arrival rate is below the service rate (λ < μ). A run offered more load than the service can serve has a queue that grows for as long as the run lasts, so its latency depends on the run's length. Erlang reports such a run as over capacity, with queue growth, and does not report its latency as a property of the service.

*Why:* the M/M/1 results hold only for "λ < µ" [S27], and Little's law needs stationary processes [S1].

## Modelling

### CAP-07 · Fit throughput against concurrency to the Universal Scalability Law
Strength: SHOULD · Evidence: theory · Check: load

From throughput measured at several levels of concurrency N, fit C(N) = N / (1 + α(N − 1) + βN(N − 1)). α measures contention (waiting for a shared resource); β measures coherency (the cost of keeping shared data consistent). Report both. When β is clearly above zero, throughput peaks at N* = √((1 − α)/β) and falls beyond it; report N* and flag any planned concurrency above it. When β is zero, throughput levels off at a ceiling instead of peaking.

*Why:* Gunther's model, first presented in 1993 [S8][S9][S10][S11]. "The important implication is that beyond p∗ the throughput becomes retrograde" [S10]. Amdahl's law, by contrast, "cannot predict the retrograde scalability commonly observed in performance evaluation measurements" [S10]. A fit says how throughput behaved at the levels tested. It is an extrapolation beyond them, and the report says so.

### CAP-08 · Size concurrency limits with Little's law
Strength: SHOULD · Evidence: theory · Check: static, load

The threads, connections or in-flight slots a route holds on average are its arrival rate times its time in the system. Size pools from that, and remember the multiplier works in reverse: if a dependency's latency rises a hundredfold, so does the concurrency it holds.

*Why:* L = λW [S1][S2][S3]. Amazon's example: a server handling 100 messages a second at 100 ms uses about 10 threads; "If the latency suddenly spiked to 10 seconds, it would suddenly use 1,000 threads" [S22]. This is why timeouts (TMO-01) and bulkheads (STB-02) matter.

### CAP-09 · Model independent arrivals as random, not evenly spaced
Strength: MAY · Evidence: theory · Check: report

When a load profile stands for many independent users, space its arrivals randomly (a Poisson process, with exponentially distributed gaps between arrivals) rather than at fixed intervals. Evenly spaced arrivals understate queueing. Where real traffic is available, its own arrival pattern takes precedence.

*Why:* Erlang's 1909 paper showed that "if telephone calls were made at random they followed the Poisson distribution" [S4][S6]. The observation was of telephone traffic; web traffic is often burstier, which makes the Poisson profile a floor, not a ceiling, for burstiness.

### CAP-10 · A finite pool means some requests wait or are refused
Strength: MAY · Evidence: theory · Check: static

With a finite number of servers, connections or workers and random arrivals, the probability that an arrival must wait (or is refused, if there is no queue) is above zero at any load. Size pools against a target waiting or refusal probability at peak, not against mean load.

*Why:* Erlang's 1917 paper gave "a formula for loss and waiting time which was soon used by telephone companies in many countries" [S5][S6]. The formulas themselves are not reproduced here; take them from a queueing text before using them for a number.

## Running the tests

### CAP-11 · Test with the cache empty when the cache carries load
Strength: SHOULD · Evidence: practice · Check: load

If a cache is there to provide capacity, not only to cut latency, the service is tested starting from an empty cache (after a deploy, a restart, a cache flush) at expected load, and load is added slowly to a cold service.

*Why:* "a service using a capacity cache cannot sustain its expected load under an empty cache" and "When adding load to a cluster, slowly increase the load" [S18].

### CAP-12 · Load only what the owner runs, within its limits
Strength: MUST · Evidence: practice, taste · Check: report

Erlang generates load only against services its owner runs: on the local machine, in CI service containers, or on a staging deployment the owner names. Never against a third party, and never against production without the owner's explicit say-so. Every run has a rate cap and a duration cap.

*Why:* load against someone else's service is a denial-of-service attack. Google adds that load tests must stay within the resources committed to them: "When performing load tests, make sure that you remain within your committed resource limits" [S18].
