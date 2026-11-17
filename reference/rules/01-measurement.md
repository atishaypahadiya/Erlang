# Measurement

What a load run must measure, and how, before any other rule can be judged from it.

## The load itself

### MEA-01 · Generate load with an open model
Strength: MUST · Evidence: practice · Check: report

Load is offered at a set arrival rate, independent of how fast the service answers, and each request's latency is measured from the time it was due to be sent. A closed loop, in which a fixed number of virtual users each wait for a reply before sending again, slows its own sending when the service slows. The slowest moments then receive the fewest requests, and the latency that matters most goes unrecorded.

*Why:* k6 calls this effect "coordinated omission" and offers arrival-rate executors to avoid it. wrk2 was written to hold a constant throughput and measure from each request's intended send time [S28][S29]. Real users do not wait for each other before arriving (CAP-09).

### MEA-02 · Check every run against Little's law
Strength: SHOULD · Evidence: theory · Check: report

Over a measurement window, mean requests in flight should equal throughput times mean time in the system (L = λW). If they disagree beyond measurement error, the run is broken: the window included a ramp, requests were lost or still in flight at its edges, or a counter is wrong. Report the disagreement instead of the run's numbers.

*Why:* Little proved L = λW for stationary processes with finite means [S1]. Over a finite window it holds exactly without the steady-state assumption only if "a finite window of observation … starts and stops when the system is empty" and no arrivals are lost [S3]. Requests that time out or are dropped break that condition, so they must be counted before the check is applied.

## What to report

### MEA-03 · Rate, errors and the latency distribution for every request-driven route
Strength: MUST · Evidence: practice · Check: report

For each route under load: requests per second, failed requests as a share of requests, and the latency distribution (percentiles up to at least p99, with the sample count), never the mean alone.

*Why:* this is Wilkie's RED method, which he describes as based on Google's four golden signals, leaving out saturation [S14][S15]. The SRE book lists the signals as "latency, traffic, errors, and saturation" [S16]. Wilkie defines duration as a distribution, not an average [S14].

### MEA-04 · Latency of successes and of failures, apart
Strength: MUST · Evidence: practice · Check: report

Success latency and error latency are reported separately. A fast error must not lower the latency of the requests that worked.

*Why:* "it's important to track error latency, as opposed to just filtering out errors" [S16]. Amazon makes the same point from the other side: "it's important not to pollute our services' latency metrics with failed request latency", since a service shedding 60 percent of its traffic can show an excellent median while its successful requests are slow [S21].

### MEA-05 · Goodput, not only throughput
Strength: MUST · Evidence: practice · Check: report

Goodput is the rate of requests that succeeded and arrived in time to be used. Requests slower than the route's latency objective count as errors, by policy.

*Why:* "Goodput is the subset of the throughput that is handled without errors and with low enough latency for the client to make use of the response" [S21]. The SRE book counts as errors requests that fail "by policy", such as any request over a committed response time [S16]. The capacity oracle (CAP-02) is stated in goodput.

### MEA-06 · Utilisation, saturation and errors for every resource on the path
Strength: SHOULD · Evidence: practice · Check: trace

For each resource a request uses, report how busy it was, how much work waited for it, and its error count. Resources include software ones: connection pools, worker pools, file descriptors, queues. Utilisation here is time busy, not share of capacity used; say which definition a number uses.

*Why:* Gregg's USE method: "For every resource, check utilization, saturation, and errors." He extends it to "software resources as well, or software imposed limits", and notes the second definition of utilisation, under which 100% means no more work can be accepted [S12][S13].

### MEA-07 · Any saturation is a finding; long averages hide it
Strength: SHOULD · Evidence: practice · Check: trace, load

A resource with work queued for it is reported, however short the queue. Utilisation is sampled over short intervals, since a moderate average can hide bursts at 100%.

*Why:* "any degree of saturation can be a problem (non-zero)" and "a total utilization of, say, 70% can hide short bursts of 100% utilization" [S12].

### MEA-08 · High percentiles over short windows as the early warning
Strength: SHOULD · Evidence: practice · Check: load

Track p99 latency per short window (one minute or less) during a run. A rising p99 is usually the first sign of saturation, before errors appear.

*Why:* "Latency increases are often a leading indicator of saturation. Measuring your 99th percentile response time over some small window (e.g., one minute) can give a very early signal of saturation" [S16]. In a fan-out, "the 99th percentile of one backend can easily become the median response of your frontend" [S16].

### MEA-09 · Client-side and server-side numbers both
Strength: SHOULD · Evidence: practice · Check: report

The load driver's measurements (what a caller saw) are reported beside the service's own. A gap between them is time spent in queues, connection setup or the network that the service never counted.

*Why:* Amazon measures "client-perceived availability and latency in addition to server-side availability and latency" [S21].

### MEA-10 · RED is for request-driven services only
Strength: MUST · Evidence: practice · Check: report

Queue consumers, batch jobs and streaming workers are judged by USE (MEA-06) and by the age of the work waiting for them, not by request rate and latency.

*Why:* Wilkie: the method "only works for request-driven services - it breaks down for batch-oriented or streaming services" [S14]. For queues, Amazon focuses "more on measuring the age of messages that are in the queue" than on its depth [S22].
