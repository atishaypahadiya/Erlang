// Serves one fixture twin for the trace harness (scripts/trace.sh): imports
// the twin's src/server.js, which exports a Fastify `app`, records the routes
// it registers, and listens on 127.0.0.1 only, on a port the system picks.
// When it is listening it writes { port, routes } to <ready file>. It reads
// DATABASE_URL from its environment, as the twin's own db.js does.
//
// Usage: node scripts/trace/serve.js <twin dir> <ready file>

import { writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dir, ready] = process.argv.slice(2);
if (!dir || !ready) {
  console.error('usage: node scripts/trace/serve.js <twin dir> <ready file>');
  process.exit(64);
}
const { app } = await import(pathToFileURL(join(resolve(dir), 'src', 'server.js')).href);
const routes = [];
app.addHook('onRoute', (r) => {
  for (const method of [r.method].flat()) if (method !== 'HEAD') routes.push({ method, url: r.url });
});
await app.listen({ host: '127.0.0.1', port: 0 });
const { address, port } = app.server.address();
if (address !== '127.0.0.1') throw new Error(`listening on ${address}, not 127.0.0.1`);
writeFileSync(`${ready}.part`, JSON.stringify({ port, routes }));
renameSync(`${ready}.part`, ready);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.close().then(() => process.exit(0)));
