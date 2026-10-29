import { Router } from "express";
import { apiRateLimit } from "../middleware/http.js";
import {
  csrfProtection,
  sessionCookie,
  requireUser,
} from "../middleware/auth.js";
export function authRouter(
  service,
  config,
  { authLimit, redis, recovery } = {},
) {
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
  router.use(
    apiRateLimit({
      max: 15,
      windowMs: 900000,
      ...authLimit,
      store: redis,
      bucket: "auth-ip",
      exemptMedia: false,
    }),
  );
  router.use(csrfProtection(config));
  router.use(
    apiRateLimit({
      max: 10,
      windowMs: 900000,
      store: redis,
      bucket: "auth-account",
      exemptMedia: false,
      key: (req) =>
        typeof req.body?.email === "string" && req.body.email.length <= 254
          ? req.body.email.trim().toLowerCase()
          : null,
    }),
  );
  router.post("/demo", async (req, res) => {
    if (req.user)
      return res.status(409).json({
        error: { message: "Sign out before starting another session." },
      });
    const guest = await service.guest(req.sessionHash);
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

  router.post("/forgot-password", async (req, res) => {
    const email = req.body?.email;
    if (
      typeof email !== "string" ||
      email.length > 254 ||
      !/^\S+@[^\s@]+\.[^\s@]+$/.test(email) ||
      Object.keys(req.body).some((k) => k !== "email")
    )
      return res
        .status(400)
        .json({ error: { message: "A valid email is required." } });
    await recovery.requestReset(email.trim().toLowerCase());
    res
      .status(202)
      .json({ message: "If this account exists, a reset link will be sent." });
  });
  router.post("/request-verification", requireUser, async (req, res) => {
    if (req.user.kind !== "registered")
      return res
        .status(403)
        .json({ error: { message: "Create an account to verify an email." } });
    await recovery.requestVerification(req.user.id);
    res
      .status(202)
      .json({ message: "If verification is needed, a link will be sent." });
  });
  router.post("/verify-email", async (req, res) => {
    if (!req.body || Object.keys(req.body).some((k) => k !== "token"))
      return res
        .status(400)
        .json({ error: { message: "A verification token is required." } });
    await recovery.verify(req.body.token);
    res.json({
      message:
        "Email verified. Refresh your account to see the updated status.",
    });
  });
  router.post("/reset-password", async (req, res) => {
    const body = req.body;
    if (
      !body ||
      Object.keys(body).some((k) => !["token", "password"].includes(k)) ||
      typeof body.password !== "string" ||
      body.password.length < 12 ||
      Buffer.byteLength(body.password) > 256
    )
      return res.status(400).json({
        error: {
          message:
            "Use a password of at least 12 characters and at most 256 bytes.",
        },
      });
    await recovery.reset(body.token, body.password);
    sessionCookie(res, config, "");
    res.json({
      message:
        "Password reset. Sign in with your new password; previous sessions were revoked.",
    });
  });
  router.post("/logout", async (req, res) => {
    if (req.sessionHash) await service.logout(req.sessionHash);
    sessionCookie(res, config, "");
    res.status(204).end();
  });
  return router;
}
