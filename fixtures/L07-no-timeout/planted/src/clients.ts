import axios from 'axios';

export const billing = axios.create({ baseURL: process.env.BILLING_URL });

export const catalog = axios.create({ baseURL: process.env.CATALOG_URL, timeout: 3000 });
