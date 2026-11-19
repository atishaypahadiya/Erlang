// Answers 503 to everything while MAINTENANCE is set; not a limit on load,
// and not applied to any app here.
export function maintenance(req, res, next) {
  if (process.env.MAINTENANCE) return res.status(503).end();
  next();
}
