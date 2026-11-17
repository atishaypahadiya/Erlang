import axios from 'axios';

const BASE = process.env.SHIPPING_URL;

export async function track(code) {
  const { data } = await axios.get(`${BASE}/track/${code}`);
  return data;
}

export async function label(order) {
  const { data } = await axios.post(`${BASE}/labels`, { order: order.id }, { timeout: 2000 });
  return data;
}
