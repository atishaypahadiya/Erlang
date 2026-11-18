// Run by hand after a deploy; no request waits on it.
import { setTimeout as sleep } from 'node:timers/promises';

for (let attempt = 0; attempt < 5; attempt++) {
  const res = await fetch(`${process.env.CATALOG_URL}/warm`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
  if (res.ok) break;
  await sleep(2000);
}
