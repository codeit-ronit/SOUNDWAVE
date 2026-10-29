import { analyticsRepository } from "../repositories/analytics.js";
import { catalogRepository } from "../repositories/catalog.js";
import { analyticsOverview } from "../services/analytics.js";
import { Router } from "express";
import { recordEvent } from "../repositories/listening.js";
import { requireUser } from "../middleware/auth.js";
export function analyticsRouter(db) {
  const router = Router();
  const repo = analyticsRepository(db);
  const catalog = catalogRepository(db);
  router.use("/analytics", requireUser);
  const fail = (res, message, status = 400) =>
    res.status(status).json({ error: { message } });
  router.post("/analytics/events", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body))
      return fail(res, "A JSON event object is required.");
    if (
      Object.keys(body).some(
        (k) =>
          ![
            "id",
            "type",
            "chapterId",
            "listeningSeconds",
            "playbackRate",
          ].includes(k),
      )
    )
      return fail(res, "Unknown analytics field.");
    const {
      id,
      type,
      chapterId,
      listeningSeconds = 0,
      playbackRate = 1,
    } = body;
    if (
      typeof id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      return fail(res, "id must be a UUID.");
    if (
      !["playback_started", "playback_paused", "listening_interval"].includes(
        type,
      )
    )
      return fail(res, "Unsupported playback event type.");
    if (!Number.isSafeInteger(chapterId) || chapterId < 1)
      return fail(res, "A valid chapterId is required.");
    if (
      typeof listeningSeconds !== "number" ||
      !Number.isFinite(listeningSeconds) ||
      listeningSeconds < 0 ||
      listeningSeconds > 60 ||
      (type === "playback_started" && listeningSeconds !== 0)
    )
      return fail(
        res,
        "listeningSeconds must be between 0 and 60; started events must have zero duration.",
      );
    if (![0.75, 1, 1.25, 1.5, 2].includes(playbackRate))
      return fail(res, "Invalid playbackRate.");
    const chapter = await catalog.chapter(chapterId);
    if (!chapter) return fail(res, "Chapter not found.", 404);
    const previous = await repo.event(req.user.id, id);
    if (
      previous &&
      (previous.event_type !== type ||
        previous.chapter_id !== chapterId ||
        previous.listening_seconds !== listeningSeconds ||
        JSON.parse(previous.metadata).playbackRate !== playbackRate)
    )
      return fail(res, "Event ID already belongs to a different event.", 409);
    const result = await recordEvent(db, {
      user: req.user.id,
      id,
      type,
      chapterId,
      storyId: chapter.story_id,
      listeningSeconds,
      playbackRate,
    });
    const stored = await repo.event(req.user.id, id);
    if (
      stored.event_type !== type ||
      stored.chapter_id !== chapterId ||
      stored.listening_seconds !== listeningSeconds ||
      JSON.parse(stored.metadata).playbackRate !== playbackRate
    )
      return fail(res, "Event ID already belongs to a different event.", 409);
    res
      .status(result.changes ? 201 : 200)
      .json({ eventId: id, duplicate: !result.changes });
  });
  router.get("/analytics/overview", async (req, res) => {
    res.json(await analyticsOverview(db, req.user.id));
  });
  return router;
}
