import { hashToken, publicUser, sameToken } from "../services/auth.js";
export function identityMiddleware(service, config) {
  return async (req, res, next) => {
    const raw = (req.headers.cookie || "")
      .split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith(config.cookieName + "="))
      ?.slice(config.cookieName.length + 1);
    req.session = await service.lookup(raw);
    req.sessionHash = raw && /^[a-f0-9]{64}$/.test(raw) ? hashToken(raw) : null;
    req.invalidSession = !!raw && !req.session;
    req.user = req.session?.user_id ? publicUser(req.session) : null;
    if (req.get("X-Session-User") && req.get("X-Session-User") !== req.user?.id)
      return res.status(409).json({
        error: {
          message: "The active account changed. Refresh before continuing.",
        },
      });
    // Personalized JSON must not enter browser/proxy shared caches.
    res.set("Cache-Control", "private, no-store");
    res.vary("Cookie");
    next();
  };
}
export const requireUser = (req, res, next) =>
  req.user
    ? next()
    : res
        .status(401)
        .json({ error: { message: "Sign in or start a demo session." } });
export function csrfProtection(config) {
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("Origin");
    const allowed = new Set([
      config.origin,
      ...(!config.production
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : []),
    ]);
    if (!config.production) allowed.add(`${req.protocol}://${req.get("host")}`);
    if (
      (origin && !allowed.has(origin)) ||
      req.get("Sec-Fetch-Site") === "cross-site" ||
      !sameToken(req.get("X-CSRF-Token"), req.session?.csrf_token)
    )
      return res.status(403).json({
        error: { message: "CSRF validation failed. Refresh and retry." },
      });
    next();
  };
}
export function sessionCookie(res, config, value, seconds = 0) {
  res.cookie(config.cookieName, value, {
    httpOnly: true,
    secure: config.production,
    sameSite: "lax",
    path: "/",
    maxAge: seconds * 1000,
  });
}
