// A worker thread for GET /export: it holds the orders' JSON bytes, given to
// it when they change, and compresses them on request, returning one buffer,
// so the main thread only writes the response.
import { parentPort } from 'node:worker_threads';
import zlib from 'node:zlib';

let held = null;

parentPort.on('message', ({ id, bytes }) => {
  if (bytes) held = bytes;
  if (id === undefined) return;
  try {
    const out = zlib.gzipSync(held);
    const body = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out.buffer : out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    parentPort.postMessage({ id, body }, [body]);
  } catch (err) {
    parentPort.postMessage({ id, error: String(err) });
  }
});
