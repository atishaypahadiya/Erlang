import pRetry, { AbortError } from 'p-retry';

// A price quote from the pricing service.
export async function quote(sku) {
  return pRetry(async () => {
    const res = await fetch(`${process.env.PRICING_URL}/quotes/${sku}`, { signal: AbortSignal.timeout(2000) });
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new AbortError(`pricing replied ${res.status}`);
    if (!res.ok) throw new Error(`pricing replied ${res.status}`);
    return res.json();
  }, { retries: 4 });
}

// Stock levels from the warehouse, with jittered, capped backoff.
export async function stock(sku) {
  const levels = await pRetry(async () => {
    const res = await fetch(`${process.env.WAREHOUSE_URL}/stock/${sku}`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`warehouse replied ${res.status}`);
    return res.json();
  }, { retries: 3, randomize: true, maxTimeout: 5000 });
  return levels;
}

// Exchange rates, with jittered, capped backoff; 4xx replies are not retried.
export async function rates() {
  return await pRetry(async () => {
    const res = await fetch(`${process.env.RATES_URL}/latest`, { signal: AbortSignal.timeout(2000) });
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new AbortError(`rates replied ${res.status}`);
    if (!res.ok) throw new Error(`rates replied ${res.status}`);
    return res.json();
  }, { retries: 3, randomize: true, maxTimeout: 5000 });
}
