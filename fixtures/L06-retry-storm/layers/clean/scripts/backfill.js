// Run by hand: every product's stock, retried on top of axios-retry. No request runs it.
import { stock } from '../src/clients.js';

for (const id of [1, 2, 3]) {
  for (let attempt = 1; ; attempt++) {
    try {
      console.log((await stock.get(`/stock/${id}`)).data);
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, Math.random() * Math.min(10_000, 100 * 2 ** attempt)));
    }
  }
}
