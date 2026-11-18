import axios from 'axios';
import axiosRetry from 'axios-retry';
import got from 'got';

// The payments service, retried three times.
export const payments = axios.create({ baseURL: process.env.PAYMENTS_URL, timeout: 2000 });
axiosRetry(payments, { retries: 3 });

// The inventory service, retried with the library's exponential backoff.
export const inventory = axios.create({ baseURL: process.env.INVENTORY_URL, timeout: 2000 });
axiosRetry(inventory, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

// The shipping service, retried until it answers.
export const shipping = got.extend({ prefixUrl: process.env.SHIPPING_URL, timeout: { request: 2000 }, retry: { limit: Infinity } });

// The catalog service, with got's default retry: 2 retries, 1 s then 2 s, plus up to 100 ms of noise.
export const catalog = got.extend({ prefixUrl: process.env.CATALOG_URL, timeout: { request: 2000 } });
