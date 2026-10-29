import { saveFavorite, saveProgress } from "../repositories/listening.js";
import { requireUser } from "../middleware/auth.js";
import { Router } from "express";
import { serializeStory } from "../db.js";
import { catalogRepository, sorts } from "../repositories/catalog.js";
import { listeningHistory, recommendations } from "../services/discovery.js";
const fail = (res, message, status = 400) =>
  res.status(status).json({ error: { message } });
const validId = (value) =>
  typeof value === "string" && /^[1-9]\d{0,8}$/.test(value);

export function apiRouter(db) {
  const api = Router();
  const repo = catalogRepository(db);
  const getStory = repo.story;
  api.get("/health", async (req, res) => {
    await repo.health();
    res.json({ status: "ok", service: "soundwave", database: db.dialect });
  });
  api.get("/genres", async (_req, res) =>
    res.json({ genres: await repo.genres() }),
  );
  api.get("/stories", async (req, res) => {
    const user = req.user?.id || null;
    const { q = "", genre = "", sort = "trending" } = req.query;
    if (
      typeof q !== "string" ||
      q.length > 100 ||
      typeof genre !== "string" ||
      genre.length > 40
    )
      return fail(
        res,
        "q must be a string up to 100 characters; genre must be a string up to 40 characters.",
      );
    if (typeof sort !== "string" || !Object.hasOwn(sorts, sort))
      return fail(res, "sort must be trending, title, or newest.");
    const stories = await repo.stories(user, { q, genre, sort });
    res.json({ stories, total: stories.length });
  });
  api.get("/stories/:id", async (req, res) => {
    const user = req.user?.id || null;
    if (!validId(req.params.id)) return fail(res, "Invalid story ID.");
    const story = await getStory(user, Number(req.params.id));
    if (!story) return fail(res, "Story not found.", 404);
    res.json({ story: serializeStory(story) });
  });
  api.get("/stories/:id/chapters", async (req, res) => {
    const user = req.user?.id || null;
    if (!validId(req.params.id)) return fail(res, "Invalid story ID.");
    if (!(await getStory(user, Number(req.params.id))))
      return fail(res, "Story not found.", 404);
    res.json({ chapters: await repo.chapters(user, Number(req.params.id)) });
  });
  api.get("/library", requireUser, async (req, res) => {
    const user = req.user?.id || null;
    res.json({ stories: await repo.library(user) });
  });
  api.put("/library/:storyId", requireUser, async (req, res) => {
    const user = req.user?.id || null;
    if (!validId(req.params.storyId)) return fail(res, "Invalid story ID.");
    const storyId = Number(req.params.storyId);
    if (!(await getStory(user, storyId)))
      return fail(res, "Story not found.", 404);
    await saveFavorite(db, user, storyId);
    res.json({ story: serializeStory(await getStory(user, storyId)) });
  });
  api.delete("/library/:storyId", requireUser, async (req, res) => {
    const user = req.user?.id || null;
    if (!validId(req.params.storyId)) return fail(res, "Invalid story ID.");
    const storyId = Number(req.params.storyId);
    if (!(await getStory(user, storyId)))
      return fail(res, "Story not found.", 404);
    await repo.removeFavorite(user, storyId);
    res.status(204).end();
  });
  api.get("/progress", requireUser, async (req, res) =>
    res.json(await listeningHistory(repo, req.user.id)),
  );
  api.put("/progress/:chapterId", requireUser, async (req, res) => {
    const user = req.user?.id || null;
    if (!validId(req.params.chapterId)) return fail(res, "Invalid chapter ID.");
    const chapter = await repo.chapter(Number(req.params.chapterId));
    if (!chapter) return fail(res, "Chapter not found.", 404);
    const body = req.body;
    if (!body || Array.isArray(body) || typeof body !== "object")
      return fail(res, "A JSON object is required.");
    const { positionSeconds, completed = false, clientId, sequence } = body;
    if (
      Object.keys(body).some(
        (k) =>
          !["positionSeconds", "completed", "clientId", "sequence"].includes(k),
      )
    )
      return fail(res, "Unknown progress field.");
    if (
      typeof positionSeconds !== "number" ||
      !Number.isFinite(positionSeconds) ||
      positionSeconds < 0 ||
      positionSeconds > chapter.duration_seconds + 1
    )
      return fail(
        res,
        "positionSeconds must be a finite number within the chapter duration.",
      );
    if (typeof completed !== "boolean")
      return fail(res, "completed must be a boolean.");
    if (completed && positionSeconds < chapter.duration_seconds - 1)
      return fail(res, "A completed chapter must be at its end.");
    const versioned = clientId !== undefined || sequence !== undefined;
    if (
      versioned &&
      (typeof clientId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          clientId,
        ) ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1)
    )
      return fail(
        res,
        "clientId and a positive integer sequence must be supplied together.",
      );
    const position = Math.min(positionSeconds, chapter.duration_seconds);
    const isComplete = completed || position >= chapter.duration_seconds;
    await saveProgress(db, user, chapter, {
      position,
      isComplete,
      clientId,
      sequence,
    });
    res.json({ progress: await repo.chapterProgress(user, chapter.id) });
  });
  api.get("/recommendations", async (req, res) =>
    res.json(await recommendations(repo, req.user?.id || null)),
  );
  return api;
}
