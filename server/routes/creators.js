import { Router } from "express";
import { requireUser } from "../middleware/auth.js";
import { creatorService } from "../services/creators.js";
import { permissionError } from "../services/authorization.js";
const invalid = () =>
  permissionError(
    400,
    "INVALID_CREATOR_REQUEST",
    "Provide only a displayName (1–80 characters) and bio (0–1000 characters), without control characters.",
  );
export function creatorProfileInput(body) {
  if (
    !body ||
    Array.isArray(body) ||
    typeof body !== "object" ||
    Object.keys(body).some((k) => !["displayName", "bio"].includes(k))
  )
    throw invalid();
  const name = body.displayName,
    bio = body.bio;
  if (
    typeof name !== "string" ||
    typeof bio !== "string" ||
    Array.from(name.trim()).length < 1 ||
    Array.from(name.trim()).length > 80 ||
    Array.from(bio.trim()).length > 1000 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(name) ||
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(bio)
  )
    throw invalid();
  return { name: name.trim(), bio: bio.trim() };
}
export function creatorRouter(db) {
  const router = Router(),
    service = creatorService(db);
  router.use(requireUser, (req, _res, next) =>
    Object.keys(req.query).length ? next(invalid()) : next(),
  );
  router.get("/", async (req, res) => res.json(await service.view(req.user)));
  router.post("/", async (req, res) => {
    const { name, bio } = creatorProfileInput(req.body);
    res.json(await service.activate(req.user, name, bio));
  });
  router.put("/", async (req, res) => {
    const { name, bio } = creatorProfileInput(req.body);
    res.json(await service.edit(req.user, name, bio));
  });
  router.post("/deactivate", async (req, res) => {
    if (
      !req.body ||
      Array.isArray(req.body) ||
      typeof req.body !== "object" ||
      Object.keys(req.body).length
    )
      throw invalid();
    res.json(await service.deactivate(req.user));
  });
  router.use((error, _req, res, next) => {
    if (!error.permissionCode) return next(error);
    res
      .status(error.status)
      .json({ error: { code: error.permissionCode, message: error.message } });
  });
  return router;
}
