import got from 'got';

const BASE = process.env.RATES_URL;
const fx = got.extend({ prefixUrl: process.env.FX_URL, timeout: { request: 5000 } });

export function rate(from, to) {
  return got(`${BASE}/rates/${from}/${to}`).json();
}

export function convert(amount, from, to) {
  return fx.get(`convert?amount=${amount}&from=${from}&to=${to}`).json();
}
