# Overload

What a service does when it receives more work than it can serve. The aim, from CAP-02: serve what it can, refuse the rest quickly, and recover by itself.

### OVL-01 · Fail early and cheaply
Strength: MUST · Evidence: practice · Check: load

When overloaded, the service refuses work before spending resources on it. Refusing a request must cost far less than serving it, or the service can be overloaded by its refusals alone.

*Why:* "Servers should protect themselves from becoming overloaded and crashing. When overloaded at either the frontend or backend layers, fail early and cheaply" [S18]. Google describes backends overloaded "even though the vast majority of its CPU is spent just rejecting requests" [S17].

### OVL-02 · Bound the requests in flight
Strength: SHOULD · Evidence: practice · Check: static, load

The service caps how many requests it works on at once and answers requests beyond the cap with 503 straight away, instead of accepting them all and serving every one late.

*Why:* "one effective approach is to return an HTTP 503 (service unavailable) to any incoming request when there are more than a given number of client requests in flight" [S18]. Amazon's "generally safe default is to use a spillover configuration, which fast-fails instead of queueing excess requests" [S21].

### OVL-03 · Keep queues short, and bound the time spent in them
Strength: SHOULD · Evidence: practice · Check: static, load

A queue in front of workers is small relative to the number of workers, so the service starts refusing early. Requests that have waited longer than their caller will wait are dropped.

*Why:* "it is usually better to have small queue lengths relative to the thread pool size (e.g., 50% or less), which results in the server rejecting requests early when it can't sustain the rate of incoming requests" [S18]. Amazon: "it's extremely important to place an upper bound on the amount of time that an incoming request sits on a queue" [S21].

### OVL-04 · Under overload, serve the newest first
Strength: MAY · Evidence: practice · Check: load

When a queue is backed up, last-in-first-out order or a delay-based drop policy such as CoDel serves the requests whose callers are still waiting, instead of the ones that have already given up.

*Why:* switching from FIFO "to last-in, first-out (LIFO) or using the controlled delay (CoDel) algorithm" can "reduce load by removing requests that are unlikely to be worth processing" [S18]. For backlogs, real-time systems "prefer LIFO-ish behavior" [S22].

### OVL-05 · One client cannot take all the capacity
Strength: SHOULD · Evidence: practice · Check: static, load

Per-client limits ensure that under overload only the clients over their share receive errors. No single client can hold more than a fixed share of workers.

*Why:* "When global overload does occur, it's vital that the service only delivers error responses to misbehaving customers, while other customers remain unaffected" [S17]. Google suggests, for example, "only allowing 25% of your threads to be occupied by any one client" [S18].

### OVL-06 · Shed the least important work first
Strength: MAY · Evidence: practice · Check: static

Requests carry a criticality, passed on to the calls they make, and an overloaded service refuses the least critical first.

*Why:* Google uses four criticality values; an overloaded task "will reject requests of lower criticalities sooner", and downstream calls inherit the original request's criticality by default [S17].

### OVL-07 · Measure capacity in resources, not requests per second
Strength: SHOULD · Evidence: practice · Check: load

Requests differ in cost, so a limit set in requests per second is wrong whenever the mix changes. Limits and capacity estimates are set in the resource that runs out first: CPU, memory, connections.

*Why:* modelling capacity as "queries per second" or by static features of requests "often makes for a poor metric"; "A better solution is to measure capacity directly in available resources" [S17].

### OVL-08 · Health checks: liveness apart from readiness, and first in line
Strength: SHOULD · Evidence: practice · Check: static, load

Whether the process is running and whether it can serve requests now are separate checks, so an overloaded instance is taken out of rotation, not killed and restarted into the same load. The load balancer's health check is answered even when other requests are refused.

*Why:* process health checking and service health checking "are two conceptually distinct operations" [S18]. Amazon: "The most important request that a server will receive is a ping request from a load balancer" [S21].

### OVL-09 · Exercise the degraded modes
Strength: SHOULD · Evidence: practice · Check: load

Any degraded mode (serving cached or partial results, turning off a feature under load) is triggered on purpose in testing, and its use is monitored.

*Why:* "the code path you never use is the code path that (often) doesn't work" [S18].

### OVL-10 · Queues behind the service push back
Strength: SHOULD · Evidence: practice · Check: trace, load

For work handed to a queue: track the age of the oldest message, give each workload its own consumers or concurrency limit, and slow intake as the backlog grows.

*Why:* Amazon uses "separate thread pools for each workload to avoid one workload from consuming all of the available threads", scales "an inbound throttle limit (inversely) proportionally to backlog size", and measures message age rather than queue depth [S22].

### OVL-11 · Accept no more connections than can be served
Strength: SHOULD · Evidence: practice · Check: static

The listener's maximum connections do not exceed the threads, processes or file descriptors that can serve them.

*Why:* Amazon found it important "for the maximum connections value to not exceed the number of listener threads, listener processes, or file descriptors on a server" [S21]. Google notes that running out of file descriptors can stop new connections and make health checks fail [S18].
