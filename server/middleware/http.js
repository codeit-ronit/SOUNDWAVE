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
export function apiRateLimit({
  max = 300,
  windowMs = 60000,
  store,
  bucket = "api",
  key: keyFor = (req) => req.ip,
  exemptMedia = true,
} = {}) {
  const clients = new Map();
  return async (req, res, next) => {
    if (exemptMedia && /^\/chapters\/[^/]+\/stream$/.test(req.path))
      return next();
    const now = Date.now();
    for (const [key, entry] of clients)
      if (entry.until <= now) clients.delete(key);
    const key = keyFor(req);
    if (key === null) return next();
    if (store) {
      try {
        const { count, ttlMs } = await store.consume(bucket, key, windowMs);
        const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
        res.set({
          "RateLimit-Limit": String(max),
          "RateLimit-Remaining": String(Math.max(0, max - count)),
          "RateLimit-Reset": String(seconds),
        });
        if (count > max)
          return res
            .status(429)
            .set("Retry-After", String(seconds))
            .json({
              error: {
                message: "Too many API requests. Please retry shortly.",
              },
            });
        return next();
      } catch {
        return res
          .status(503)
          .set("Retry-After", "3")
          .json({
            error: {
              message:
                "Request protection is temporarily unavailable. Please retry.",
            },
          });
      }
    }
    if (clients.size >= 10000 && !clients.has(key))
      return res
        .status(503)
        .set("Retry-After", "3")
        .json({
          error: { message: "Request protection is busy. Please retry." },
        });
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
