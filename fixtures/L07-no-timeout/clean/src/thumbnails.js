import https from 'node:https';

const log = { warn: (...args) => console.warn(...args) };

export function thumbnail(id, done) {
  const req = https.get(`https://thumbs.internal/${id}`, { timeout: 2000 }, (res) => done(null, res));
  req.on('timeout', () => req.destroy(new Error('thumbnail timed out')));
  req.on('error', done);
}
