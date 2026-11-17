import http from 'node:http';
import https from 'node:https';

export function avatar(id, done) {
  http.request(`http://avatars.internal/${id}`, { timeout: 2000 }, (res) => done(null, res)).on('error', done).end();
}

export function banner(id, done) {
  const req = https.get(`https://banners.internal/${id}`, { timeout: 2000 }, (res) => done(null, res));
  req.on('timeout', () => req.destroy(new Error('banner timed out')));
  req.on('error', done);
}

export function badge(id, done) {
  https.get(`https://badges.internal/${id}`, (res) => done(null, res)).setTimeout(2000, function () { this.destroy(); }).on('error', done);
}
