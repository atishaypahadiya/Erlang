# Retries

When a failed call may be tried again, how often, and how far apart. Retries help with brief, isolated failures and multiply load during the overloads that cause most outages, so every rule here bounds them.

Counts are given in **attempts per request** (the first try plus any retries). The sources count differently: Google's overload chapter allows "up to three attempts"; its cascading-failures chapter's example has "3 retries (4 attempts)"; Amazon's 243× example multiplies three tries per layer.

### RTY-01 · Cap the attempts per request
Strength: MUST · Evidence: practice · Check: static, trace, load

Every retry loop has a fixed maximum number of attempts. No request is retried indefinitely.

*Why:* Google implements "a per-request retry budget of up to three attempts. If a request has already failed three times, we let the failure bubble up to the caller" [S17], and "Limit retries per request. Don't retry a given request indefinitely" [S18]. Amazon: "our solution is to limit the number of times that the client retries" [S19].

### RTY-02 · Retry at one layer only
Strength: MUST · Evidence: practice · Check: static, trace, load

In a chain of calls, only one layer retries a given failure: the one directly above the layer that failed. The others pass the failure up.

*Why:* retries multiply across layers. Three tries at each layer of a five-deep stack means "the load on the database will increase 243x" [S19]; three layers each making four attempts means "64 attempts (4^3)" from one user action [S18]. Google: "requests should only be retried at the layer immediately above the layer that is rejecting them" [S17]. Amazon's practice is "to retry at a single point in the stack" [S19].

### RTY-03 · Back off exponentially, with a cap and with jitter
Strength: MUST · Evidence: practice · Check: static, trace

The wait before each retry grows exponentially up to a maximum, and is randomised. The common form ("full jitter") waits a random time between zero and min(cap, base × 2^attempt). A fixed delay, or exponential backoff without randomness, is a defect.

*Why:* "Always use randomized exponential backoff when scheduling retries" [S18]. Without jitter, "If all the failed calls back off to the same time, they cause contention or overload again when they are retried" [S19]. In Brooker's simulation of 100 contending clients, jitter "reduced our call count by more than half", and plain exponential backoff "is the clear loser" [S20]. The simulation models write contention on shared data; its conclusion is applied to retry storms by analogy.

### RTY-04 · Prefer full jitter
Strength: MAY · Evidence: practice · Check: static

Among the jittered schemes, full jitter does the least total work; decorrelated jitter is an acceptable alternative.

*Why:* in the same simulation, "Of the jittered approaches, 'Equal Jitter' is the loser" and "The 'Full Jitter' approach uses less work, but slightly more time" [S20].

### RTY-05 · Keep a retry budget for the whole client
Strength: SHOULD · Evidence: practice · Check: static, load

Beyond the per-request cap, each client process limits retries across all requests: as a share of requests (Google keeps retries below 10%) or as a token bucket that allows retries while tokens last and then only at a fixed rate. When the budget is spent, fail instead of retrying.

*Why:* Google retries a request only while the ratio of retries to requests "is below 10%", which cuts worst-case load growth from "just below 3X" to "just 1.1x in the general case" [S17], and suggests a server-wide budget such as "60 retries per minute in a process" [S18]. Amazon limits "retries locally using a token bucket" and added this to its SDK in 2016 [S19].

### RTY-06 · Do not retry what cannot succeed
Strength: MUST · Evidence: practice · Check: static, trace

Permanent errors and malformed requests (most 4xx replies) are not retried. A reply that says the service is overloaded and not to retry is honoured. A service that is overloaded says so with a distinct status.

*Why:* "Don't retry permanent errors or malformed requests in a client, because neither will ever succeed. Return a specific status when overloaded so that clients and other layers back off and do not retry" [S18]. Google's overloaded tasks return "an 'overloaded; don't retry' error response" [S17]. Amazon: "client errors should not be retried with the same request because they aren't going to succeed later" [S19]. When overload is widespread, "requests should not be retried and errors should bubble up all the way to the caller" [S17].

### RTY-07 · Retry a call with side effects only if it is idempotent
Strength: MUST · Evidence: practice · Check: static

A call that changes state (a payment, an insert, a sent message) is retried only if the receiver de-duplicates it, for instance by an idempotency key.

*Why:* "APIs with side effects aren't safe to retry unless they provide idempotency" [S19].

### RTY-08 · Jitter every timer and periodic job
Strength: SHOULD · Evidence: practice · Check: static

Scheduled work (cache refreshes, polling, cron jobs, token renewal) runs at a randomised offset, so that many instances do not act at the same moment.

*Why:* Amazon considers "adding some jitter to all timers, periodic jobs, and other delayed work" [S19].

### RTY-09 · Clients may throttle themselves when rejected
Strength: MAY · Evidence: practice · Check: static, load

A client that sees many of its recent requests rejected sends fewer. Google's form drops each new request locally with probability max(0, (requests − K × accepts) / (requests + 1)), counted over the last two minutes, with K = 2.

*Why:* "When a client detects that a significant portion of its recent requests have been rejected due to 'out of quota' errors, it starts self-regulating and caps the amount of outgoing traffic it generates" [S17]. "We generally prefer the 2x multiplier" [S17]. The formula is printed as an image in the online chapter and is transcribed here. The chapter notes it may not work well for clients that send requests only rarely.
