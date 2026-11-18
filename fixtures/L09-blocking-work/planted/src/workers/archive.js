// A worker thread: compression here does not hold up the request thread.
import { parentPort } from 'node:worker_threads';
import zlib from 'node:zlib';

parentPort.on('message', (data) => {
  parentPort.postMessage(zlib.deflateSync(data));
});
