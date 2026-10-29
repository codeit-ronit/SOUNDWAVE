import { randomUUID } from "node:crypto";
export function requestContext(logger) {
  return (req, res, next) => {
    const started = performance.now();
    req.requestId = randomUUID();
    res.set("X-Request-ID", req.requestId);
    if (logger)
      res.on("finish", () =>
        logger({
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round((performance.now() - started) * 100) / 100,
        }),
      );
    next();
  };
}
// Process-local demo limit. Media byte ranges are exempt so seeks are not throttled.
export function apiRateLimit({ max = 300, windowMs = 60000 } = {}) {
  const clients = new Map();
  return (req, res, next) => {
    if (/^\/chapters\/[^/]+\/stream$/.test(req.path)) return next();
    const now = Date.now();
    for (const [key, entry] of clients)
      if (entry.until <= now) clients.delete(key);
    const key = req.ip;
    let entry = clients.get(key);
    if (!entry) {
      entry = { count: 0, until: now + windowMs };
      clients.set(key, entry);
    }
    entry.count++;
    const seconds = Math.max(1, Math.ceil((entry.until - now) / 1000));
    res.set({
      "RateLimit-Limit": String(max),
      "RateLimit-Remaining": String(Math.max(0, max - entry.count)),
      "RateLimit-Reset": String(seconds),
    });
    if (entry.count > max)
      return res
        .status(429)
        .set("Retry-After", String(seconds))
        .json({
          error: { message: "Too many API requests. Please retry shortly." },
        });
    next();
  };
}
