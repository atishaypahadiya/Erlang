import axios from 'axios';

export const warehouse = axios.create({ baseURL: process.env.WAREHOUSE_URL ?? 'http://warehouse.internal', timeout: 5000 });
