// Refuses requests over a cap with 503 at once, rather than queueing them.
export function shed(cap) {
  let inFlight = 0;
  return function shedding(req, res, next) {
    if (inFlight >= cap) return res.status(503).set('retry-after', '1').end();
    inFlight++;
    res.on('close', () => { inFlight--; });
    next();
  };
}
