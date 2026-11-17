import https from 'node:https';

const log = { warn: (...args) => console.warn(...args) };

export function thumbnail(id, done) {
  const req = https.get(`https://thumbs.internal/${id}`, { timeout: 2000 }, (res) => done(null, res));
  req.on('timeout', () => log.warn('thumbnail is slow', id));
  req.on('error', done);
}
