import { createServer } from 'node:http';

// The metrics endpoint for the scraper: one connection at a time is plenty.
const metrics = createServer(function scrape(req, res) {
  res.end(`up 1\n`);
});
metrics.maxConnections = 4;
metrics.listen(9100, '127.0.0.1');
