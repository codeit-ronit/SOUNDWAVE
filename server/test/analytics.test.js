import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { openDatabase, seedDatabase } from "../db.js";
import { createApp } from "../app.js";
let db, app;
beforeEach(() => {
  db = openDatabase(":memory:");
  seedDatabase(db);
  app = createApp(db);
});
afterEach(() => db.close());
const event = (overrides = {}) => ({
  id: randomUUID(),
  type: "listening_interval",
  chapterId: 101,
  listeningSeconds: 5,
  playbackRate: 1,
  ...overrides,
});
test("new listener analytics are real zeroes with a seven-day timeline", async () => {
  const { body } = await request(app)
    .get("/api/analytics/overview")
    .expect(200);
  assert.equal(body.totalListeningSeconds, 0);
  assert.equal(body.completedChapters, 0);
  assert.equal(body.favoriteStories, 0);
  assert.deepEqual(body.genres, []);
  assert.deepEqual(body.recentActivity, []);
  assert.equal(body.dailyActivity.length, 7);
});
test("event UUIDs are idempotent, and conflicting reuse is rejected", async () => {
  const body = event();
  await request(app).post("/api/analytics/events").send(body).expect(201);
  const repeated = await request(app)
    .post("/api/analytics/events")
    .send(body)
    .expect(200);
  assert.equal(repeated.body.duplicate, true);
  await request(app)
    .post("/api/analytics/events")
    .send({ ...body, listeningSeconds: 6 })
    .expect(409);
  assert.equal(
    (await request(app).get("/api/analytics/overview")).body
      .totalListeningSeconds,
    5,
  );
});
test("listening time sums intervals, not absolute seeks or saved progress", async () => {
  await request(app)
    .put("/api/progress/101")
    .send({ positionSeconds: 30 })
    .expect(200);
  assert.equal(
    (await request(app).get("/api/analytics/overview")).body
      .totalListeningSeconds,
    0,
  );
  await request(app)
    .post("/api/analytics/events")
    .send(event({ type: "playback_started", listeningSeconds: 0 }))
    .expect(201);
  await request(app).post("/api/analytics/events").send(event()).expect(201);
  await request(app)
    .post("/api/analytics/events")
    .send(
      event({
        type: "playback_paused",
        chapterId: 201,
        listeningSeconds: 2.5,
        playbackRate: 2,
      }),
    )
    .expect(201);
  const { body } = await request(app)
    .get("/api/analytics/overview")
    .expect(200);
  assert.equal(body.totalListeningSeconds, 7.5);
  assert.equal(body.genres[0].genre, "Mystery");
  assert.equal(body.genres[0].listeningSeconds, 5);
  assert.equal(body.genres[1].genre, "Sci-Fi");
  assert.equal(body.dailyActivity.at(-1).listeningSeconds, 7.5);
  assert.equal(body.recentActivity.length, 3);
});
test("favorite and completion transitions generate events atomically without duplicate PUT events", async () => {
  await request(app).put("/api/library/1").expect(200);
  await request(app).put("/api/library/1").expect(200);
  const duration = db
    .prepare("SELECT duration_seconds FROM chapters WHERE id=101")
    .get().duration_seconds;
  for (let i = 0; i < 2; i++)
    await request(app)
      .put("/api/progress/101")
      .send({ positionSeconds: duration, completed: true })
      .expect(200);
  const { body } = await request(app)
    .get("/api/analytics/overview")
    .expect(200);
  assert.equal(body.completedChapters, 1);
  assert.equal(body.favoriteStories, 1);
  assert.equal(
    body.recentActivity.filter((e) => e.event_type === "story_favorited")
      .length,
    1,
  );
  assert.equal(
    body.recentActivity.filter((e) => e.event_type === "chapter_completed")
      .length,
    1,
  );
  assert.equal(body.totalListeningSeconds, 0);
  await request(app).delete("/api/library/1").expect(204);
  assert.equal(
    (await request(app).get("/api/analytics/overview")).body.favoriteStories,
    0,
  );
});
test("invalid analytics bodies, unsupported types and implausible intervals are rejected", async () => {
  for (const body of [
    [],
    {},
    event({ id: "bad" }),
    event({ chapterId: "101" }),
    event({ type: "made_up" }),
    event({ type: "chapter_completed" }),
    event({ listeningSeconds: -1 }),
    event({ listeningSeconds: 61 }),
    event({ listeningSeconds: "10" }),
    event({ playbackRate: 9 }),
    event({ type: "playback_started", listeningSeconds: 5 }),
    { ...event(), storyId: 2 },
  ])
    await request(app).post("/api/analytics/events").send(body).expect(400);
  await request(app)
    .post("/api/analytics/events")
    .send(event({ chapterId: 999 }))
    .expect(404);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM listening_events").get().count,
    0,
  );
});
test("schema initialization and reseeding preserve existing progress, favorites and analytics", async () => {
  await request(app).put("/api/library/1").expect(200);
  await request(app)
    .put("/api/progress/101")
    .send({ positionSeconds: 8 })
    .expect(200);
  await request(app).post("/api/analytics/events").send(event()).expect(201);
  seedDatabase(db);
  assert.equal(
    (await request(app).get("/api/progress")).body.progress[0].position_seconds,
    8,
  );
  const { body } = await request(app).get("/api/analytics/overview");
  assert.equal(body.favoriteStories, 1);
  assert.equal(body.totalListeningSeconds, 5);
});
test("recent activity is bounded and includes server timestamps with chapter and story names", async () => {
  for (let i = 0; i < 23; i++)
    await request(app).post("/api/analytics/events").send(event()).expect(201);
  const { body } = await request(app).get("/api/analytics/overview");
  assert.equal(body.recentActivity.length, 20);
  assert.equal(body.recentActivity[0].story_title, "The Midnight Frequency");
  assert.equal(body.recentActivity[0].chapter_title, "A voice in the static");
  assert.ok(body.recentActivity[0].created_at.endsWith("Z"));
  assert.equal(body.totalListeningSeconds, 115);
});
