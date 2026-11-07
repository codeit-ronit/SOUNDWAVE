import { Router } from "express";
import { requireUser } from "../middleware/auth.js";
import { accountError, accountService } from "../services/account.js";
const invalid = (message) =>
  accountError(400, "INVALID_ACCOUNT_REQUEST", message);
function object(body, keys) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !Object.keys(body).length ||
    Object.keys(body).some((k) => !keys.includes(k))
  )
    throw invalid("Provide only the documented profile/settings fields.");
}
export function accountRouter(db) {
  const router = Router(),
    service = accountService(db);
  router.use(["/profile", "/settings"], requireUser, (req, _res, next) => {
    if (Object.keys(req.query).length)
      return next(
        invalid("No query parameters or owner selectors are accepted."),
      );
    next();
  });
  router.get("/profile", async (req, res) =>
    res.json({ profile: await service.profile(req.user.id) }),
  );
  router.put("/profile", async (req, res) => {
    object(req.body, ["displayName"]);
    const raw = req.body.displayName;
    if (
      typeof raw !== "string" ||
      !raw.trim() ||
      Array.from(raw.trim()).length > 80 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(raw)
    )
      throw invalid(
        "Display name must contain 1–80 characters without control characters.",
      );
    res.json({ profile: await service.rename(req.user.id, raw.trim()) });
  });
  router.get("/settings", async (req, res) =>
    res.json({ settings: await service.settings(req.user.id) }),
  );
  router.put("/settings", async (req, res) => {
    object(req.body, ["playbackSpeed", "autoplayNext", "defaultVolume"]);
    const p = req.body;
    if (
      Object.hasOwn(p, "playbackSpeed") &&
      ![0.75, 1, 1.25, 1.5, 2].includes(p.playbackSpeed)
    )
      throw invalid("playbackSpeed must be 0.75, 1, 1.25, 1.5 or 2.");
    if (Object.hasOwn(p, "autoplayNext") && typeof p.autoplayNext !== "boolean")
      throw invalid("autoplayNext must be a boolean.");
    if (
      Object.hasOwn(p, "defaultVolume") &&
      (typeof p.defaultVolume !== "number" ||
        !Number.isFinite(p.defaultVolume) ||
        p.defaultVolume < 0 ||
        p.defaultVolume > 1)
    )
      throw invalid("defaultVolume must be a finite number from 0 to 1.");
    res.json({ settings: await service.saveSettings(req.user.id, p) });
  });
  router.use((err, _req, res, next) => {
    if (!err.accountCode) return next(err);
    res
      .status(err.status)
      .json({ error: { code: err.accountCode, message: err.message } });
  });
  return router;
}
