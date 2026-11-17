import axios from 'axios';

export const billing = axios.create({ baseURL: process.env.BILLING_URL, timeout: 3000 });

export const catalog = axios.create({ baseURL: process.env.CATALOG_URL, timeout: 3000 });
