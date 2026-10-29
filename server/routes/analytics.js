import { Router } from "express";
import { randomUUID } from "node:crypto";
import { DEMO_USER } from "../db.js";
export function recordEvent(
  db,
  {
    id = randomUUID(),
    type,
    storyId,
    chapterId = null,
    listeningSeconds = 0,
    playbackRate = 1,
  },
) {
  return db
    .prepare(
      `INSERT INTO listening_events (event_id,user_id,story_id,chapter_id,event_type,listening_seconds,metadata)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`,
    )
    .run(
      id,
      DEMO_USER,
      storyId,
      chapterId,
      type,
      listeningSeconds,
      JSON.stringify({ playbackRate }),
    );
}
export function analyticsRouter(db) {
  const router = Router();
  const fail = (res, message, status = 400) =>
    res.status(status).json({ error: { message } });
  router.post("/analytics/events", (req, res) => {
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
    const chapter = db
      .prepare("SELECT story_id FROM chapters WHERE id=?")
      .get(chapterId);
    if (!chapter) return fail(res, "Chapter not found.", 404);
    const previous = db
      .prepare("SELECT * FROM listening_events WHERE event_id=?")
      .get(id);
    if (
      previous &&
      (previous.event_type !== type ||
        previous.chapter_id !== chapterId ||
        previous.listening_seconds !== listeningSeconds ||
        JSON.parse(previous.metadata).playbackRate !== playbackRate)
    )
      return fail(res, "Event ID already belongs to a different event.", 409);
    const result = recordEvent(db, {
      id,
      type,
      chapterId,
      storyId: chapter.story_id,
      listeningSeconds,
      playbackRate,
    });
    res
      .status(result.changes ? 201 : 200)
      .json({ eventId: id, duplicate: !result.changes });
  });
  router.get("/analytics/overview", (_req, res) => {
    const user = DEMO_USER;
    const total = db
      .prepare(
        "SELECT COALESCE(SUM(listening_seconds),0) AS seconds FROM listening_events WHERE user_id=?",
      )
      .get(user).seconds;
    const completed = db
      .prepare(
        "SELECT COUNT(*) AS count FROM listening_progress WHERE user_id=? AND completed=1",
      )
      .get(user).count;
    const favorites = db
      .prepare("SELECT COUNT(*) AS count FROM favorites WHERE user_id=?")
      .get(user).count;
    const genres = db
      .prepare(
        `SELECT s.genre,SUM(e.listening_seconds) AS listeningSeconds FROM listening_events e
      JOIN stories s ON s.id=e.story_id WHERE e.user_id=? AND e.listening_seconds>0 GROUP BY s.genre ORDER BY listeningSeconds DESC,s.genre`,
      )
      .all(user);
    const days = Array.from({ length: 7 }, (_, i) =>
      new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10),
    );
    const activity = db
      .prepare(
        `SELECT date(created_at) AS date,SUM(listening_seconds) AS listeningSeconds FROM listening_events
      WHERE user_id=? AND created_at>=? GROUP BY date(created_at)`,
      )
      .all(user, `${days[0]}T00:00:00.000Z`);
    const recentActivity = db
      .prepare(
        `SELECT e.event_id,e.event_type,e.created_at,e.listening_seconds,s.id AS story_id,s.title AS story_title,
      c.title AS chapter_title FROM listening_events e JOIN stories s ON s.id=e.story_id LEFT JOIN chapters c ON c.id=e.chapter_id
      WHERE e.user_id=? ORDER BY e.created_at DESC,e.rowid DESC LIMIT 20`,
      )
      .all(user);
    res.json({
      totalListeningSeconds: Math.round(total * 1000) / 1000,
      completedChapters: completed,
      favoriteStories: favorites,
      genres,
      dailyActivity: days.map((date) => ({
        date,
        listeningSeconds:
          activity.find((row) => row.date === date)?.listeningSeconds || 0,
      })),
      recentActivity,
      measurement: "Recorded online playback wall time; seeks are excluded.",
    });
  });
  return router;
}
