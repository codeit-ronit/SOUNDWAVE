import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../app.js";
import { openDatabase, seedDatabase } from "../db.js";
let db, app;
beforeEach(() => {
  db = openDatabase(":memory:");
  seedDatabase(db);
  app = createApp(db);
});
afterEach(() => db.close());

test("health endpoint and configured local CORS", async () => {
  const res = await request(app)
    .get("/api/health")
    .set("Origin", "http://127.0.0.1:5173")
    .expect(200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.user, "demo-user");
  assert.equal(
    res.headers["access-control-allow-origin"],
    "http://127.0.0.1:5173",
  );
});
test("story catalog, details, genres and ordered playable chapters", async () => {
  const listing = await request(app).get("/api/stories").expect(200);
  assert.equal(listing.body.stories.length, 6);
  assert.equal(listing.body.stories[0].id, 1);
  const detail = await request(app).get("/api/stories/1").expect(200);
  assert.equal(detail.body.story.title, "The Midnight Frequency");
  const chapters = await request(app)
    .get("/api/stories/1/chapters")
    .expect(200);
  assert.deepEqual(
    chapters.body.chapters.map((c) => c.chapter_number),
    [1, 2],
  );
  assert.ok(
    chapters.body.chapters.every(
      (c) => c.duration_seconds > 20 && c.audio_url.endsWith(".wav"),
    ),
  );
  const genres = await request(app).get("/api/genres").expect(200);
  assert.equal(genres.body.genres.length, 5);
});
test("backend title and genre search is case-insensitive and combines with filters", async () => {
  assert.equal(
    (await request(app).get("/api/stories?q=midnight").expect(200)).body.total,
    1,
  );
  assert.equal(
    (await request(app).get("/api/stories?q=MYSTERY").expect(200)).body.total,
    2,
  );
  assert.equal(
    (await request(app).get("/api/stories?q=the&genre=mystery").expect(200))
      .body.total,
    2,
  );
  assert.equal(
    (
      await request(app)
        .get("/api/stories?q=midnight&genre=Romance")
        .expect(200)
    ).body.total,
    0,
  );
  assert.equal(
    (await request(app).get("/api/stories?q=nothingmatches").expect(200)).body
      .total,
    0,
  );
});
test("sorting uses allowed SQL orderings", async () => {
  const alpha = (
    await request(app).get("/api/stories?sort=title").expect(200)
  ).body.stories.map((s) => s.title);
  assert.deepEqual(
    alpha,
    [...alpha].sort((a, b) => a.localeCompare(b)),
  );
  const newest = (
    await request(app).get("/api/stories?sort=newest").expect(200)
  ).body.stories;
  assert.equal(newest[0].id, 6);
});
test("search treats wildcard and SQL injection text as literal data", async () => {
  for (const q of ["%", "_", "' OR 1=1 --", "\\"]) {
    const res = await request(app).get("/api/stories").query({ q }).expect(200);
    assert.equal(res.body.total, 0);
  }
  assert.equal(
    (await request(app).get("/api/stories").expect(200)).body.total,
    6,
  );
});
test("invalid search types, length and sort return consistent 400 errors", async () => {
  for (const query of [
    "q=a&q=b",
    `q=${"a".repeat(101)}`,
    "genre=a&genre=b",
    "sort=DROP",
    "sort=toString",
    "sort=a&sort=b",
  ]) {
    const res = await request(app).get(`/api/stories?${query}`).expect(400);
    assert.equal(typeof res.body.error.message, "string");
  }
});
test("malformed IDs and missing resources have distinct errors", async () => {
  for (const path of [
    "/stories/no",
    "/stories/0",
    "/stories/1.2",
    "/stories/-1/chapters",
  ])
    await request(app).get(`/api${path}`).expect(400);
  await request(app).get("/api/stories/999").expect(404);
  await request(app).get("/api/stories/999/chapters").expect(404);
  await request(app)
    .put("/api/progress/no")
    .send({ positionSeconds: 1 })
    .expect(400);
  await request(app)
    .put("/api/progress/999")
    .send({ positionSeconds: 1 })
    .expect(404);
  await request(app).get("/api/missing").expect(404);
});
test("favorites add, retrieve, avoid duplicates and remove idempotently", async () => {
  assert.deepEqual(
    (await request(app).get("/api/library").expect(200)).body.stories,
    [],
  );
  const added = await request(app).put("/api/library/1").expect(200);
  assert.equal(added.body.story.is_favorite, true);
  await request(app).put("/api/library/1").expect(200);
  assert.equal((await request(app).get("/api/library")).body.stories.length, 1);
  assert.equal(
    (await request(app).get("/api/stories/1")).body.story.is_favorite,
    true,
  );
  await request(app).delete("/api/library/1").expect(204);
  await request(app).delete("/api/library/1").expect(204);
  assert.equal((await request(app).get("/api/library")).body.stories.length, 0);
});
test("favorites reject invalid and missing story IDs", async () => {
  for (const method of ["put", "delete"]) {
    await request(app)[method]("/api/library/bad").expect(400);
    await request(app)[method]("/api/library/999").expect(404);
  }
});
test("progress upserts one row and is included in chapters and continue listening", async () => {
  await request(app)
    .put("/api/progress/101")
    .send({ positionSeconds: 8.5 })
    .expect(200);
  await request(app)
    .put("/api/progress/101")
    .send({ positionSeconds: 12.25 })
    .expect(200);
  const { body } = await request(app).get("/api/progress").expect(200);
  assert.equal(body.progress.length, 1);
  assert.equal(body.progress[0].position_seconds, 12.25);
  assert.equal(body.progress[0].completed, false);
  assert.ok(body.progress[0].updated_at.endsWith("Z"));
  assert.equal(body.continueListening[0].resume_chapter_id, 101);
  const chapters = (await request(app).get("/api/stories/1/chapters")).body
    .chapters;
  assert.equal(chapters[0].position_seconds, 12.25);
});
test("completion advances continue listening then removes a fully completed story", async () => {
  const chapters = (await request(app).get("/api/stories/1/chapters")).body
    .chapters;
  await request(app)
    .put("/api/progress/101")
    .send({ positionSeconds: chapters[0].duration_seconds, completed: true })
    .expect(200);
  assert.equal(
    (await request(app).get("/api/progress")).body.continueListening[0]
      .resume_chapter_id,
    102,
  );
  await request(app)
    .put("/api/progress/102")
    .send({ positionSeconds: chapters[1].duration_seconds, completed: true })
    .expect(200);
  const progress = (await request(app).get("/api/progress")).body;
  assert.equal(progress.continueListening.length, 0);
  assert.ok(progress.progress.every((p) => p.completed));
  await request(app)
    .put("/api/progress/101")
    .send({ positionSeconds: 2, completed: false })
    .expect(200);
  assert.equal(
    (await request(app).get("/api/progress")).body.continueListening[0]
      .resume_chapter_id,
    101,
  );
});
test("invalid progress bodies cannot corrupt existing saved state", async () => {
  await request(app)
    .put("/api/progress/101")
    .send({ positionSeconds: 5 })
    .expect(200);
  for (const body of [
    {},
    [],
    { positionSeconds: -1 },
    { positionSeconds: "4" },
    { positionSeconds: null },
    { positionSeconds: 1e9 },
    { positionSeconds: 1, completed: "true" },
    { positionSeconds: 1, completed: true },
    { positionSeconds: 1, other: "ignored?" },
  ]) {
    await request(app).put("/api/progress/101").send(body).expect(400);
  }
  await request(app)
    .put("/api/progress/101")
    .type("json")
    .send("{broken")
    .expect(400);
  assert.equal(
    (await request(app).get("/api/progress")).body.progress[0].position_seconds,
    5,
  );
});
test("progress and favorites survive a database close and server recreation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "soundwave-test-"));
  const path = join(dir, "test.sqlite");
  let persistent;
  try {
    persistent = openDatabase(path);
    seedDatabase(persistent);
    await request(createApp(persistent))
      .put("/api/progress/101")
      .send({ positionSeconds: 17 })
      .expect(200);
    await request(createApp(persistent)).put("/api/library/1").expect(200);
    persistent.close();
    persistent = openDatabase(path);
    seedDatabase(persistent);
    const recreated = createApp(persistent);
    assert.equal(
      (await request(recreated).get("/api/progress")).body.progress[0]
        .position_seconds,
      17,
    );
    assert.equal(
      (await request(recreated).get("/api/library")).body.stories[0].id,
      1,
    );
  } finally {
    if (persistent?.open) persistent.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("recommendations have a stable popular cold start", async () => {
  const first = (await request(app).get("/api/recommendations").expect(200))
    .body;
  const second = (await request(app).get("/api/recommendations").expect(200))
    .body;
  assert.equal(first.strategy, "rule-based");
  assert.deepEqual(first, second);
  assert.equal(first.stories[0].id, 1);
  assert.equal(first.stories[0].recommendation_score, 0);
});
test("recommendations weight favorite genres and distinct listened stories, excluding favorites", async () => {
  await request(app).put("/api/library/1").expect(200);
  await request(app)
    .put("/api/progress/101")
    .send({ positionSeconds: 5 })
    .expect(200);
  await request(app)
    .put("/api/progress/102")
    .send({ positionSeconds: 5 })
    .expect(200);
  const stories = (await request(app).get("/api/recommendations")).body.stories;
  assert.equal(stories[0].id, 6);
  assert.equal(stories[0].recommendation_score, 6);
  assert.ok(!stories.some((s) => s.id === 1));
  assert.match(stories[0].recommendation_reason, /mystery/);
});
test("fully completed stories are excluded from recommendations", async () => {
  const chapters = (await request(app).get("/api/stories/1/chapters")).body
    .chapters;
  for (const c of chapters)
    await request(app)
      .put(`/api/progress/${c.id}`)
      .send({ positionSeconds: c.duration_seconds, completed: true })
      .expect(200);
  assert.ok(
    !(await request(app).get("/api/recommendations")).body.stories.some(
      (s) => s.id === 1,
    ),
  );
});
test("all 12 local WAVs contain non-silent PCM and support HTTP byte ranges", async () => {
  const chapters = db.prepare("SELECT * FROM chapters").all();
  assert.equal(chapters.length, 12);
  for (const chapter of chapters) {
    const wav = readFileSync(
      new URL(`../public${chapter.audio_url}`, import.meta.url),
    );
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    let offset = 12,
      data;
    while (offset + 8 <= wav.length) {
      const size = wav.readUInt32LE(offset + 4);
      if (wav.toString("ascii", offset, offset + 4) === "data")
        data = wav.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size + (size % 2);
    }
    assert.ok(data?.length > 100000);
    assert.ok(data.some((value) => value !== 0));
    const res = await request(app)
      .get(chapter.audio_url)
      .set("Range", "bytes=0-99")
      .expect(206);
    assert.match(res.headers["content-type"], /audio/);
    assert.equal(Number(res.headers["content-length"]), 100);
  }
});
test("missing audio returns a JSON 404 rather than the SPA document", async () => {
  const res = await request(app).get("/audio/nonexistent.wav").expect(404);
  assert.equal(typeof res.body.error.message, "string");
});
