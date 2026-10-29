import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import request from "supertest";
import { openDatabase, seedDatabase } from "../db.js";
import { createApp } from "./helpers.js";
let db, app;
const audio = readFileSync(new URL("../public/audio/1-1.wav", import.meta.url));
beforeEach(() => {
  db = openDatabase(":memory:");
  seedDatabase(db);
  app = createApp(db);
});
afterEach(() => db.close());
const binary = (res, callback) => {
  const parts = [];
  res.on("data", (chunk) => parts.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(parts)));
};
test("stream full GET delivers exact file bytes and complete media headers", async () => {
  const res = await request(app)
    .get("/api/chapters/101/stream")
    .buffer(true)
    .parse(binary)
    .expect(200);
  assert.deepEqual(res.body, audio);
  assert.equal(Number(res.headers["content-length"]), audio.length);
  assert.equal(res.headers["accept-ranges"], "bytes");
  assert.equal(res.headers["content-type"], "audio/wav");
  assert.equal(res.headers["content-range"], undefined);
});
test("bounded, open-ended, suffix and clamped ranges return exact 206 slices", async () => {
  for (const [range, start, end] of [
    ["bytes=0-99", 0, 99],
    ["bytes=4000-", 4000, audio.length - 1],
    ["bytes=-100", audio.length - 100, audio.length - 1],
    ["bytes=10-9999999", 10, audio.length - 1],
  ]) {
    const res = await request(app)
      .get("/api/chapters/101/stream")
      .set("Range", range)
      .buffer(true)
      .parse(binary)
      .expect(206);
    assert.equal(
      res.headers["content-range"],
      `bytes ${start}-${end}/${audio.length}`,
    );
    assert.equal(Number(res.headers["content-length"]), end - start + 1);
    assert.deepEqual(res.body, audio.subarray(start, end + 1));
  }
});
test("unsatisfiable, malformed and multiple ranges return 416 with total size", async () => {
  for (const range of [
    `bytes=${audio.length}-`,
    "bytes=5-2",
    "bytes=-0",
    "bytes=-",
    "bytes=hello",
    "items=0-4",
    "bytes=0-1,5-6",
    "bytes=99999999999999999999-",
  ]) {
    const res = await request(app)
      .get("/api/chapters/101/stream")
      .set("Range", range)
      .expect(416);
    assert.equal(res.headers["content-range"], `bytes */${audio.length}`);
    assert.equal(res.headers["content-length"], "0");
  }
});
test("HEAD describes a full stream without body, ignoring Range per HTTP semantics", async () => {
  for (const range of [null, "bytes=0-99"]) {
    let call = request(app).head("/api/chapters/101/stream");
    if (range) call = call.set("Range", range);
    const res = await call.expect(200);
    assert.equal(res.text, undefined);
    assert.equal(Number(res.headers["content-length"]), audio.length);
    assert.equal(res.headers["accept-ranges"], "bytes");
  }
});
test("If-Range honors matching validators and falls back to full response for stale data", async () => {
  const head = await request(app).head("/api/chapters/101/stream").expect(200);
  await request(app)
    .get("/api/chapters/101/stream")
    .set("Range", "bytes=0-9")
    .set("If-Range", head.headers.etag)
    .expect(206);
  await request(app)
    .get("/api/chapters/101/stream")
    .set("Range", "bytes=0-9")
    .set("If-Range", '"stale"')
    .expect(200);
});
test("stream IDs and server-side file mappings prevent traversal", async () => {
  await request(app).get("/api/chapters/no/stream").expect(400);
  await request(app).get("/api/chapters/999/stream").expect(404);
  db.prepare("UPDATE chapters SET audio_url=? WHERE id=101").run(
    "/audio/../../db.js",
  );
  await request(app).get("/api/chapters/101/stream").expect(404);
  db.prepare("UPDATE chapters SET audio_url=? WHERE id=101").run(
    "/audio/999-1.wav",
  );
  await request(app).get("/api/chapters/101/stream").expect(404);
});
test("chapter API points the existing player to streaming endpoints without a schema migration", async () => {
  const res = await request(app).get("/api/stories/1/chapters").expect(200);
  assert.equal(res.body.chapters[0].audio_url, "/api/chapters/101/stream");
  assert.equal(
    db.prepare("SELECT audio_url FROM chapters WHERE id=101").get().audio_url,
    "/audio/1-1.wav",
  );
});

test("legacy audio URLs cannot expose an out-of-root symlink", async () => {
  const {
    mkdtempSync,
    writeFileSync,
    symlinkSync,
    unlinkSync,
    rmSync,
    mkdirSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "soundwave-symlink-audit-"));
  const target = join(dir, "private.txt");
  const link = new URL("../public/audio/900001-1.wav", import.meta.url);
  try {
    writeFileSync(target, "audit-private-content");
    symlinkSync(target, link);
    db.prepare("UPDATE chapters SET audio_url=? WHERE id=101").run(
      "/audio/900001-1.wav",
    );
    await request(app).get("/api/chapters/101/stream").expect(404);
    await request(app).get("/audio/900001-1.wav").expect(404);
    const directory = new URL("../public/audio/900002-1.wav", import.meta.url);
    mkdirSync(directory);
    try {
      db.prepare("UPDATE chapters SET audio_url=? WHERE id=101").run(
        "/audio/900002-1.wav",
      );
      const result = await request(app)
        .get("/api/chapters/101/stream")
        .expect(404);
      assert.equal(typeof result.body.error.message, "string");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    unlinkSync(link);
    rmSync(dir, { recursive: true, force: true });
  }
});
