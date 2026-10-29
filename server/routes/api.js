import { Router } from "express";
import {
  DEMO_USER,
  storySelect,
  serializeStory,
  serializeProgress,
} from "../db.js";
const fail = (res, message, status = 400) =>
  res.status(status).json({ error: { message } });
const validId = (value) =>
  typeof value === "string" && /^[1-9]\d{0,8}$/.test(value);
const literalLike = (value) => value.replace(/[\\%_]/g, "\\$&");

export function apiRouter(db) {
  const api = Router();
  const user = DEMO_USER;
  const getStory = (id) =>
    db.prepare(`${storySelect} WHERE s.id=@id`).get({ user, id });
  api.get("/health", (_req, res) => {
    db.prepare("SELECT 1").get();
    res.json({ status: "ok", service: "soundwave", user });
  });
  api.get("/genres", (_req, res) =>
    res.json({
      genres: db
        .prepare("SELECT DISTINCT genre FROM stories ORDER BY genre")
        .all()
        .map((r) => r.genre),
    }),
  );
  api.get("/stories", (req, res) => {
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
    const sorts = {
      trending: "s.popularity DESC, s.id ASC",
      title: "s.title COLLATE NOCASE ASC, s.id ASC",
      newest: "s.id DESC",
    };
    if (typeof sort !== "string" || !Object.hasOwn(sorts, sort))
      return fail(res, "sort must be trending, title, or newest.");
    const stories = db
      .prepare(
        `${storySelect} WHERE
      (@q='' OR s.title LIKE @pattern ESCAPE '\\' OR s.genre LIKE @pattern ESCAPE '\\')
      AND (@genre='' OR s.genre=@genre COLLATE NOCASE) ORDER BY ${sorts[sort]}`,
      )
      .all({
        user,
        q: q.trim(),
        pattern: `%${literalLike(q.trim())}%`,
        genre: genre.trim(),
      })
      .map(serializeStory);
    res.json({ stories, total: stories.length });
  });
  api.get("/stories/:id", (req, res) => {
    if (!validId(req.params.id)) return fail(res, "Invalid story ID.");
    const story = getStory(Number(req.params.id));
    if (!story) return fail(res, "Story not found.", 404);
    res.json({ story: serializeStory(story) });
  });
  api.get("/stories/:id/chapters", (req, res) => {
    if (!validId(req.params.id)) return fail(res, "Invalid story ID.");
    if (!getStory(Number(req.params.id)))
      return fail(res, "Story not found.", 404);
    const chapters = db
      .prepare(
        `SELECT c.*, COALESCE(p.position_seconds,0) AS position_seconds,
      COALESCE(p.completed,0) AS completed FROM chapters c LEFT JOIN listening_progress p
      ON p.chapter_id=c.id AND p.user_id=? WHERE c.story_id=? ORDER BY c.chapter_number`,
      )
      .all(user, Number(req.params.id));
    res.json({ chapters: chapters.map(serializeProgress) });
  });
  api.get("/library", (_req, res) => {
    res.json({
      stories: db
        .prepare(
          `${storySelect} JOIN favorites f ON f.story_id=s.id
      WHERE f.user_id=@user ORDER BY f.created_at DESC, s.id DESC`,
        )
        .all({ user })
        .map(serializeStory),
    });
  });
  api.put("/library/:storyId", (req, res) => {
    if (!validId(req.params.storyId)) return fail(res, "Invalid story ID.");
    const storyId = Number(req.params.storyId);
    if (!getStory(storyId)) return fail(res, "Story not found.", 404);
    db.prepare(
      "INSERT INTO favorites (user_id,story_id) VALUES (?,?) ON CONFLICT DO NOTHING",
    ).run(user, storyId);
    res.json({ story: serializeStory(getStory(storyId)) });
  });
  api.delete("/library/:storyId", (req, res) => {
    if (!validId(req.params.storyId)) return fail(res, "Invalid story ID.");
    const storyId = Number(req.params.storyId);
    if (!getStory(storyId)) return fail(res, "Story not found.", 404);
    db.prepare("DELETE FROM favorites WHERE user_id=? AND story_id=?").run(
      user,
      storyId,
    );
    res.status(204).end();
  });
  api.get("/progress", (_req, res) => {
    const progress = db
      .prepare(
        `SELECT p.*, c.story_id, c.title AS chapter_title, c.chapter_number,
      c.duration_seconds FROM listening_progress p JOIN chapters c ON c.id=p.chapter_id
      WHERE p.user_id=? ORDER BY p.updated_at DESC, p.chapter_id DESC`,
      )
      .all(user)
      .map(serializeProgress);
    // One continue entry per story. A completed chapter advances to the next uncompleted chapter.
    const latest = new Map();
    for (const row of progress)
      if (!latest.has(row.story_id)) latest.set(row.story_id, row);
    const continueListening = [];
    for (const row of latest.values()) {
      const chapters = db
        .prepare(
          `SELECT c.*, COALESCE(p.position_seconds,0) AS position_seconds,
        COALESCE(p.completed,0) AS completed FROM chapters c LEFT JOIN listening_progress p
        ON p.chapter_id=c.id AND p.user_id=? WHERE c.story_id=? ORDER BY c.chapter_number`,
        )
        .all(user, row.story_id);
      const current = chapters.find((c) => c.id === row.chapter_id);
      const next = current.completed
        ? chapters.find(
            (c) => c.chapter_number > current.chapter_number && !c.completed,
          ) || chapters.find((c) => !c.completed)
        : current;
      if (next)
        continueListening.push({
          ...serializeStory(getStory(row.story_id)),
          resume_chapter_id: next.id,
          chapter_title: next.title,
          chapter_number: next.chapter_number,
          position_seconds: next.position_seconds,
          chapter_duration_seconds: next.duration_seconds,
          updated_at: row.updated_at,
        });
    }
    res.json({ progress, continueListening });
  });
  api.put("/progress/:chapterId", (req, res) => {
    if (!validId(req.params.chapterId)) return fail(res, "Invalid chapter ID.");
    const chapter = db
      .prepare("SELECT * FROM chapters WHERE id=?")
      .get(Number(req.params.chapterId));
    if (!chapter) return fail(res, "Chapter not found.", 404);
    const body = req.body;
    if (!body || Array.isArray(body) || typeof body !== "object")
      return fail(res, "A JSON object is required.");
    const { positionSeconds, completed = false } = body;
    if (
      Object.keys(body).some(
        (k) => !["positionSeconds", "completed"].includes(k),
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
    const position = Math.min(positionSeconds, chapter.duration_seconds);
    const isComplete = completed || position >= chapter.duration_seconds;
    db.prepare(
      `INSERT INTO listening_progress (user_id,chapter_id,position_seconds,completed)
      VALUES (?,?,?,?) ON CONFLICT(user_id,chapter_id) DO UPDATE SET
      position_seconds=excluded.position_seconds, completed=excluded.completed,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run(
      user,
      chapter.id,
      isComplete ? chapter.duration_seconds : position,
      Number(isComplete),
    );
    res.json({
      progress: serializeProgress(
        db
          .prepare(
            "SELECT * FROM listening_progress WHERE user_id=? AND chapter_id=?",
          )
          .get(user, chapter.id),
      ),
    });
  });
  api.get("/recommendations", (_req, res) => {
    const weights = new Map();
    const add = (genre, amount) =>
      weights.set(genre, (weights.get(genre) || 0) + amount);
    for (const row of db
      .prepare(
        "SELECT s.genre FROM favorites f JOIN stories s ON s.id=f.story_id WHERE f.user_id=?",
      )
      .all(user))
      add(row.genre, 4);
    for (const row of db
      .prepare(
        `SELECT DISTINCT s.id,s.genre FROM listening_progress p
      JOIN chapters c ON c.id=p.chapter_id JOIN stories s ON s.id=c.story_id
      WHERE p.user_id=? AND (p.position_seconds>0 OR p.completed=1)`,
      )
      .all(user))
      add(row.genre, 2);
    const completed = new Set(
      db
        .prepare(
          `SELECT c.story_id FROM chapters c LEFT JOIN listening_progress p
      ON p.chapter_id=c.id AND p.user_id=? GROUP BY c.story_id HAVING COUNT(c.id)=SUM(COALESCE(p.completed,0))`,
        )
        .all(user)
        .map((r) => r.story_id),
    );
    const stories = db
      .prepare(storySelect)
      .all({ user })
      .map(serializeStory)
      .filter((s) => !s.is_favorite && !completed.has(s.id))
      .map((s) => ({
        ...s,
        recommendation_score: weights.get(s.genre) || 0,
        recommendation_reason: weights.get(s.genre)
          ? `Because you listen to ${s.genre.toLowerCase()}`
          : "Popular on SoundWave",
      }))
      .sort(
        (a, b) =>
          b.recommendation_score - a.recommendation_score ||
          b.popularity - a.popularity ||
          a.id - b.id,
      )
      .slice(0, 4);
    res.json({ strategy: "rule-based", stories });
  });
  return api;
}
