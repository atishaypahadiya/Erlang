import pRetry, { AbortError } from 'p-retry';
import { budget } from './budget.js';
// A product's price from the pricing service, retried up to 3 times with jitter.
export async function fetchPrice(id) {
  return pRetry(async () => {
    const res = await fetch(`http://127.0.0.1:4003/prices/${id}`, { signal: AbortSignal.timeout(2000) });
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new AbortError(`pricing answered ${res.status}`);
    if (!res.ok) throw new Error(`pricing answered ${res.status}`);
    return res.json();
  }, { retries: 3, randomize: true, maxTimeout: 10_000, shouldRetry: () => budget.spend() });
}
