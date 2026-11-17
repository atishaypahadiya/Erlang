import https from 'node:https';
import http from 'node:http';

export function lookup(ip, done) {
  https.get(`https://geo.internal/ip/${ip}`, (res) => collect(res, done)).on('error', done);
}

export function region(ip, done) {
  http.get(`http://region.internal/ip/${ip}`, { signal: AbortSignal.timeout(2000) }, (res) => collect(res, done)).on('error', done);
}

function collect(res, done) {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => done(null, JSON.parse(body)));
}
