import axios from 'axios';
import axiosRetry from 'axios-retry';
import got from 'got';
import { budget } from './budget.js';
// The stock service: 3 retries with jittered exponential waits.
export const stock = axios.create({ baseURL: 'http://127.0.0.1:4001', timeout: 2000 });
axiosRetry(stock, { retries: 3, retryDelay: axiosRetry.exponentialDelay, retryCondition: (e) => axiosRetry.isNetworkOrIdempotentRequestError(e) && budget.spend() });

// The reviews service, through got with its defaults: 2 retries for GET.
export const reviews = got.extend({ prefixUrl: 'http://127.0.0.1:4002', timeout: { request: 2000 } });
// Fulfilment: got does not retry a POST on its own.
export const fulfilment = got.extend({ prefixUrl: 'http://127.0.0.1:4004', timeout: { request: 2000 } });
// Search, with no retries of its own.
export const search = axios.create({ baseURL: 'http://127.0.0.1:4005', timeout: 2000 });
