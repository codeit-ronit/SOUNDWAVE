// Only legacy route-contract tests inject an identity. No HTTP header or runtime
// environment variable enables this fixture; auth.test.js exercises real sessions.
import { createApp as realApp } from "../app.js";
export function createApp(db, options = {}) {
  return realApp(db, {
    ...options,
    identity: (req, res, next) => {
      req.user = { id: "demo-user", kind: "legacy" };
      next();
    },
    csrf: (_req, _res, next) => next(),
  });
}
