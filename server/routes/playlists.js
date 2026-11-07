import { Router } from "express";
import { requireUser } from "../middleware/auth.js";
import { playlistError, playlistService } from "../services/playlists.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message) =>
  playlistError(400, "INVALID_PLAYLIST_REQUEST", message);
function nameBody(body) {
  if (
    !body ||
    Array.isArray(body) ||
    typeof body !== "object" ||
    Object.keys(body).some((k) => k !== "name") ||
    typeof body.name !== "string"
  )
    throw invalid("Provide only a playlist name.");
  const name = body.name.trim();
  if (
    !name ||
    Array.from(name).length > 80 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(body.name)
  )
    throw invalid(
      "Use a playlist name of 1–80 characters without control characters.",
    );
  return name;
}
function emptyBody(body) {
  if (
    body !== undefined &&
    (!body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length)
  )
    throw invalid("No fields are accepted for this operation.");
}
function pagination(query) {
  if (Object.keys(query).some((k) => !["limit", "cursor"].includes(k)))
    throw invalid("Only limit and cursor query parameters are supported.");
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (
    (query.limit !== undefined &&
      (typeof query.limit !== "string" || !/^[1-9]\d?$/.test(query.limit))) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw invalid("limit must be an integer from 1 to 50.");
  let cursor;
  if (query.cursor !== undefined) {
    try {
      if (
        typeof query.cursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,240}$/.test(query.cursor)
      )
        throw Error();
      const bytes = Buffer.from(query.cursor, "base64url");
      if (bytes.toString("base64url") !== query.cursor) throw Error();
      cursor = JSON.parse(bytes.toString("utf8"));
      if (
        !cursor ||
        Object.keys(cursor).length !== 2 ||
        !uuid.test(cursor.id) ||
        typeof cursor.at !== "string" ||
        !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.at) ||
        new Date(cursor.at).toISOString() !== cursor.at
      )
        throw Error();
      cursor.id = cursor.id.toLowerCase();
    } catch {
      throw invalid("Invalid playlist cursor.");
    }
  }
  return { limit, cursor };
}
export function playlistRouter(db) {
  const router = Router(),
    service = playlistService(db);
  router.use(requireUser);
  router.get("/", async (req, res) => {
    const { limit, cursor } = pagination(req.query);
    res.json(await service.list(req.user.id, limit, cursor));
  });
  router.post("/", async (req, res) =>
    res.status(201).json({
      playlist: await service.create(req.user.id, nameBody(req.body)),
    }),
  );
  router.param("id", (req, _res, next, id) => {
    if (!uuid.test(id)) return next(invalid("Invalid playlist ID."));
    req.params.id = id.toLowerCase();
    next();
  });
  router.param("storyId", (req, _res, next, id) => {
    if (!/^[1-9]\d{0,8}$/.test(id)) return next(invalid("Invalid story ID."));
    next();
  });
  router.get("/:id", async (req, res) =>
    res.json(await service.detail(req.user.id, req.params.id)),
  );
  router.put("/:id", async (req, res) =>
    res.json({
      playlist: await service.rename(
        req.user.id,
        req.params.id,
        nameBody(req.body),
      ),
    }),
  );
  router.delete("/:id", async (req, res) => {
    emptyBody(req.body);
    await service.remove(req.user.id, req.params.id);
    res.status(204).end();
  });
  router.put("/:id/stories/:storyId", async (req, res) => {
    emptyBody(req.body);
    res.json({
      playlist: await service.add(
        req.user.id,
        req.params.id,
        Number(req.params.storyId),
      ),
    });
  });
  router.delete("/:id/stories/:storyId", async (req, res) => {
    emptyBody(req.body);
    await service.removeStory(
      req.user.id,
      req.params.id,
      Number(req.params.storyId),
    );
    res.status(204).end();
  });
  router.use((err, _req, res, next) => {
    if (!err.playlistCode) return next(err);
    res
      .status(err.status)
      .json({ error: { code: err.playlistCode, message: err.message } });
  });
  return router;
}
