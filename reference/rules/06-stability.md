# Stability

Structures that stop one failure from spreading: isolation, bounds on what accumulates, and decisions made in advance about what happens when a dependency fails. Most names here come from the contents of Nygard's *Release It!* (2nd edition). Its text on the patterns was not read for this set, so descriptions come from the other sources cited.

### STB-01 · Every integration point has a planned failure
Strength: MUST · Evidence: practice · Check: static

For each dependency the service calls, the code decides what happens when the call fails or is slow: an error to the caller, a cached or default answer, or the feature turned off. This goes with its timeout (TMO-01) and its retry policy (RTY-01 to RTY-07).

*Why:* "Integration points are the number-one killer of systems. Every single one of those feeds presents a stability risk" [S23]. "A failure in one component causes load to be redistributed to its peers and introduces delays and stress to its callers" [S23].

### STB-02 · Separate pools for separate dependencies (bulkheads)
Strength: SHOULD · Evidence: practice · Check: static, load

Each dependency, or each class of work, uses its own bounded pool of connections, threads or concurrency slots. A slow dependency then exhausts its own pool, not the pool everything else uses.

*Why:* Nygard names the pattern Bulkheads [S23]. Microsoft describes it: "Isolate the elements of an application into pools so that if one element fails, the others continue to function"; a consumer "might be assigned a connection pool for each service" [S25]. Amazon uses "separate thread pools for each workload" [S22].

### STB-03 · Circuit breakers are an option, not a requirement
Strength: MAY · Evidence: practice · Check: static, load

A circuit breaker stops calling a dependency after failures pass a threshold, returns errors at once while open, and lets a trial call through after a wait ("half-open") to see whether the dependency has recovered. Where one is used, not every error trips it, and its state changes are logged.

*Why:* Nygard popularised the pattern [S23][S24]. Fowler: "Once the failures reach a certain threshold, the circuit breaker trips, and all further calls to the circuit breaker return with an error, without the protected call being made at all", and "Any change in breaker state should be logged" [S24]. Amazon prefers a local retry budget (RTY-05), since "circuit breakers introduce modal behavior into systems that can be difficult to test" [S19]. With the sources divided, a retry budget satisfies this set and a breaker is optional.

### STB-04 · Every result set is bounded
Strength: MUST · Evidence: practice, research · Check: static, trace, load

Every query and list endpoint has a limit enforced by the server. Lists are paginated, with a maximum page size the client cannot raise. A query whose result grows with the data, with no limit, is a defect.

*Why:* Nygard names "Unbounded Result Sets" among the stability antipatterns [S23]. Amazon exposes any API "that can return a large dataset (or really any list at all)" as one "that supports pagination" [S21]. In a study of twelve open-source Rails applications, showing all records on one page was the most common cause of the scalability problems found [S30].

### STB-05 · What accumulates has a bound
Strength: SHOULD · Evidence: craft · Check: static, load

Anything that grows while the service runs (in-process caches, maps keyed by request data, session stores, buffers, logs on local disk) has a limit on size or age, and is purged when it reaches it.

*Why:* Nygard names a Steady State pattern [S23]; the description here is this set's own, as the book's text was not read. A collection that only grows turns a long-running service into one that fails after a predictable uptime, and a load test of a few minutes will not show it unless it runs long enough with varied keys.

### STB-06 · Fail fast when a dependency is known to be down
Strength: SHOULD · Evidence: practice · Check: static, load

When a request cannot succeed (a required dependency is unavailable, a breaker is open, the deadline is already spent), the service says so at once, without first doing the rest of the work.

*Why:* Nygard names Fail Fast among the stability patterns [S23]. The SRE book: "If your RPC layer supports a fail-fast option, use it" [S18].

### STB-07 · No calls sideways within a layer
Strength: MAY · Evidence: practice · Check: static, trace

In the request path, calls go down the stack, to dependencies, not across to peers in the same tier, which can form cycles under load.

*Why:* "It's usually better to avoid intra-layer communication—i.e., possible cycles in the communication path—in the user request path" [S18].

### STB-08 · Return every pooled connection on every path
Strength: MUST · Evidence: platform · Check: static, trace, load

A connection checked out of a pool is returned on every path out of the code that took it, errors included: in a `finally` block, or by a helper that owns the checkout. A connection that is not returned is lost to the pool until the process restarts.

*Why:* node-postgres: "You must **always** return the client to the pool if you successfully check it out, regardless of whether or not there was an error with the queries you ran on the client. If you don't release the client your application will leak them and eventually your pool will be empty forever and all future requests to check out a client from the pool will wait forever" [S35]. Its API reference: "If you forget to release the client then your application will quickly exhaust available, idle clients in the pool" [S36].

### STB-09 · Hold a pooled connection only while using it
Strength: SHOULD · Evidence: platform, theory · Check: static, trace, load

Code that holds a connection does not wait on another service while holding it. Calls to other services happen before the connection is taken or after it is returned.

*Why:* when every connection is checked out, node-postgres queues further requests "in a FIFO queue until a client becomes available by being released back to the pool" [S36]. By Little's law [S1], the connections in use on average are the rate of checkouts times how long each is held. A call to another service while holding one adds that service's latency to every hold. A slow dependency then exhausts the database pool, as STB-02 warns, even though the database itself is idle.

### STB-10 · Build what requests need before taking requests
Strength: SHOULD · Evidence: platform · Check: static, trace, load

Expensive set-up that every request depends on (a lookup table built from a file or the database, a large module, a client that must connect) is done when the process starts, and the service reports ready only after it is done. It is not done by whichever request happens to need it first.

*Why:* AWS advises to "Initialize SDK clients and database connections outside of the function handler", so that "Subsequent invocations processed by the same instance of your function can reuse these resources" [S40]. Kubernetes' readiness probes exist for the same case: "an application might need to load large data or configuration files during startup", and while it does, "you don't want to send it requests" [S41]. Set-up inside a handler instead makes the first requests after every deploy or restart wait for it, and when the value is assigned only after the work finishes, each request that arrives in the meantime starts the work again.

## Release It! names and where they are covered

The names are from the book's contents [S23]. The mapping goes by the names alone and is this set's reading, not the book's.

| Release It! name | Kind | Covered by |
|---|---|---|
| Integration Points | antipattern | STB-01, TMO-01 |
| Cascading Failures | antipattern | OVL-01 to OVL-05, RTY-02 |
| Blocked Threads | antipattern | TMO-01, STB-02, STB-09, CAP-08, OVL-12 |
| Slow Responses | antipattern | TMO-04, TMO-06 |
| Unbounded Result Sets | antipattern | STB-04 |
| Timeouts | pattern | TMO-01 to TMO-06 |
| Circuit Breaker | pattern | STB-03 |
| Bulkheads | pattern | STB-02 |
| Steady State | pattern | STB-05 |
| Fail Fast | pattern | STB-06 |
| Shed Load | pattern | OVL-01, OVL-02 |
| Create Back Pressure | pattern | OVL-03, OVL-10 |

Chain Reactions, Users, Dogpile, Self-Denial Attacks, Scaling Effects, Unbalanced Capacities, Force Multiplier, Let It Crash, Handshaking, Test Harnesses, Decoupling Middleware and Governor are also in the book and are not mapped, because their content was not read for this set.
