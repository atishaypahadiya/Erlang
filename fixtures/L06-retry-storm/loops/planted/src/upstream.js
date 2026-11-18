import axios from 'axios';
import { setTimeout as sleep } from 'node:timers/promises';

// A user's profile from the accounts service.
export async function profile(id) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return (await axios.get(`${process.env.ACCOUNTS_URL}/users/${id}`, { timeout: 2000 })).data;
    } catch (err) {
      if (attempt === 3 || err.response?.status < 500) throw err;
    }
  }
}

// Recommendations, retried every second.
export async function recommendations(id) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return (await axios.get(`${process.env.RECS_URL}/for/${id}`, { timeout: 2000 })).data;
    } catch (err) {
      if (err.response?.status < 500 || attempt === 3) throw err;
      await sleep(1000);
    }
  }
}

// The fraud score: asked until the fraud service answers.
export async function fraudScore(order) {
  let attempt = 0;
  while (true) {
    try {
      return (await axios.post(`${process.env.FRAUD_URL}/score`, order, { timeout: 2000 })).data;
    } catch (err) {
      if (err.response?.status < 500) throw err;
      attempt++;
      await sleep(Math.random() * Math.min(10_000, 100 * 2 ** attempt));
    }
  }
}

// Tax for an order, retried with backoff until the tax service replies.
export async function tax(order) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${process.env.TAX_URL}/tax`, { method: 'POST', body: JSON.stringify(order), signal: AbortSignal.timeout(2000) });
    if (res.ok) return res.json();
    await sleep(Math.random() * Math.min(10_000, 100 * 2 ** attempt));
  }
  throw new Error('tax service unavailable');
}

// Delivery slots: jittered, capped backoff, at most 3 attempts, 4xx not retried.
export async function slots(zip) {
  for (let tries = 0; tries < 3; tries++) {
    try {
      return (await axios.get(`${process.env.DELIVERY_URL}/slots/${zip}`, { timeout: 2000 })).data;
    } catch (err) {
      if (tries === 2 || err.response?.status < 500) throw err;
      await sleep(Math.random() * Math.min(10_000, 100 * 2 ** tries));
    }
  }
}

// An export job's result: polled until the job says it is done.
export async function exportResult(jobId) {
  for (;;) {
    const res = await fetch(`${process.env.EXPORTS_URL}/jobs/${jobId}`, { signal: AbortSignal.timeout(2000) });
    const job = await res.json();
    if (job.done) return job.result;
    await sleep(1000);
  }
}

// Every page of a user's orders, up to 10 pages; a failed page ends the list.
export async function orderPages(userId) {
  const orders = [];
  for (let page = 1; page <= 10; page++) {
    try {
      const { data } = await axios.get(`${process.env.ORDERS_URL}/users/${userId}/orders?page=${page}`, { timeout: 2000 });
      if (!data.length) break;
      orders.push(...data);
    } catch {
      break;
    }
  }
  return orders;
}

// Each item's current price; an item whose price fails is left out.
export async function prices(skus) {
  const out = {};
  for (const sku of skus) {
    try {
      out[sku] = (await axios.get(`${process.env.PRICING_URL}/prices/${sku}`, { timeout: 2000 })).data;
    } catch {
      continue;
    }
  }
  return out;
}
