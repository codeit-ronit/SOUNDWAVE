import { Router } from "express";
import { apiRateLimit } from "../middleware/http.js";
import { csrfProtection, sessionCookie } from "../middleware/auth.js";
export function authRouter(service, config, { authLimit } = {}) {
  const router = Router();
  const send = (res, result) => {
    sessionCookie(res, config, result.raw, result.seconds);
    return res.json({
      user: result.user,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt,
      demoEnabled: config.demoEnabled,
    });
  };
  router.get("/session", async (req, res) => {
    if (req.invalidSession) {
      sessionCookie(res, config, "");
      return res
        .status(401)
        .json({ error: { message: "Session expired. Please reconnect." } });
    }
    if (req.session)
      return res.json({
        user: req.user,
        csrfToken: req.session.csrf_token,
        expiresAt: req.session.expires_at,
        demoEnabled: config.demoEnabled,
      });
    send(res, await service.issue({ id: null }, null));
  });
  router.use(apiRateLimit(authLimit || { max: 15, windowMs: 900000 }));
  router.use(csrfProtection(config));
  router.post("/demo", async (req, res) => {
    if (req.user)
      return res.status(409).json({
        error: { message: "Sign out before starting another session." },
      });
    const guest = await service.guest();
    if (req.sessionHash) await service.logout(req.sessionHash);
    send(res, guest);
  });
  for (const action of ["register", "login"])
    router.post("/" + action, async (req, res) => {
      const body = req.body;
      const allowed =
        action === "register"
          ? ["email", "password", "displayName"]
          : ["email", "password"];
      if (
        !body ||
        Array.isArray(body) ||
        typeof body !== "object" ||
        Object.keys(body).some((k) => !allowed.includes(k)) ||
        typeof body.email !== "string" ||
        body.email.length > 254 ||
        !/^\S+@[^\s@]+\.[^\s@]+$/.test(body.email) ||
        typeof body.password !== "string" ||
        body.password.length < 12 ||
        Buffer.byteLength(body.password, "utf8") > 256 ||
        (action === "register" &&
          (typeof body.displayName !== "string" ||
            !body.displayName.trim() ||
            body.displayName.trim().length > 80))
      )
        return res.status(400).json({
          error: {
            message:
              "Use a valid email, a 12–256 byte password, and a name of 1–80 characters for registration.",
          },
        });
      const input = {
        ...body,
        email: body.email.trim().toLowerCase(),
        displayName: body.displayName?.trim(),
      };
      send(res, await service[action](input, req.sessionHash));
    });
  router.post("/logout", async (req, res) => {
    if (req.sessionHash) await service.logout(req.sessionHash);
    sessionCookie(res, config, "");
    res.status(204).end();
  });
  return router;
}
