# Timeouts and deadlines

How long any call may wait, and how a request's time budget is carried through the calls it makes.

### TMO-01 · Every outbound call has a timeout
Strength: MUST · Evidence: practice · Check: static, trace, load

Every call that leaves the process (HTTP, database, cache, queue, DNS, a call to another process on the same machine) has a connection timeout and a request timeout. A call with no timeout, or with a client library's default of waiting forever, is a defect.

*Why:* Nygard: "Every socket, process, pipe, or remote procedure call can and will hang", and for socket reads "Often, the default is to block forever" [S23]. Amazon's practice is "to set a timeout on any remote call, and generally on any call across processes even on the same box. This includes both a connection timeout and a request timeout" [S19]. Google: "Setting either no deadline or an extremely high deadline may cause short-term problems that have long since passed to continue to consume server resources until the server restarts" [S18]. A call that never returns holds its thread, connection and memory (CAP-08).

### TMO-02 · The timeout covers the whole call
Strength: SHOULD · Evidence: practice · Check: static

The timeout bounds every phase: DNS lookup, connecting, the TLS handshake, sending, and reading the reply. A read timeout alone leaves the other phases unbounded.

*Why:* "There are also implementations where the timeout doesn't cover all remote calls, like DNS or TLS handshakes" [S19].

### TMO-03 · Set a timeout from the dependency's measured latency
Strength: SHOULD · Evidence: practice · Check: trace

Pick an acceptable rate of false timeouts, then set the timeout at the matching percentile of the dependency's latency: 0.1% false timeouts means p99.9. The approach fails when the dependency's p99.9 is close to its p50; then the timeout comes from the caller's own deadline.

*Why:* Amazon chooses "an acceptable rate of false timeouts (such as 0.1%)" and then looks "at the corresponding latency percentile on the downstream service (p99.9 in this example)", noting that this "doesn't work with services that have tight latency bounds, where p99.9 is close to p50" [S19].

### TMO-04 · Deadlines stay within a few multiples of normal latency
Strength: SHOULD · Evidence: practice · Check: static, trace

A timeout many times longer than the call's normal latency protects nothing: under load, requests pile up for the whole timeout before any are released.

*Why:* "Having deadlines several orders of magnitude longer than the mean request latency is usually bad" [S18]. In the SRE book's worked example, a 100-second deadline on a call where 5% of requests never complete leaves the frontend able to serve 19.6% of requests [S18].

### TMO-05 · Pass the remaining deadline on
Strength: SHOULD · Evidence: practice · Check: static, trace

A request's time budget is set once, at the edge, and each call it makes downstream gets what remains of it, less a small margin, instead of a fixed timeout of its own.

*Why:* "Rather than inventing a deadline when sending RPCs to backends, servers should employ deadline propagation": if server A picks 30 seconds and spends 7, its call to B gets 23 [S18]. Amazon propagates "the 'remaining time' deadline between each hop" [S21].

### TMO-06 · Drop work whose deadline has passed
Strength: SHOULD · Evidence: practice · Check: trace, load

Before each stage of work on a request, the service checks the time left. A request whose caller has already given up is abandoned, including when it is taken from a queue.

*Why:* "the server should check the deadline left at each stage before attempting to perform any more work on the request", since "you don't get credit for late assignments with RPCs" [S18]. Amazon enforces "a 'per-request time-to-live'" and throws "away doomed requests" [S21].

### TMO-07 · Pass cancellation on
Strength: SHOULD · Evidence: practice · Check: static, trace

When a caller cancels or disconnects, the cancellation reaches every call made on its behalf.

*Why:* "Propagating cancellations reduces unneeded or doomed work by advising servers in an RPC call stack that their efforts are no longer necessary" [S18].

### TMO-08 · Test a dependency that never answers
Strength: SHOULD · Evidence: practice · Check: load

For each dependency, and above all the noncritical ones, run the service with that dependency accepting connections and never replying. The service keeps serving what does not need it.

*Why:* "test how the frontend behaves if the noncritical backend never responds (for example, if it is blackholing requests)" [S18]. A dependency that refuses connections fails fast; one that hangs is the case timeouts exist for.
