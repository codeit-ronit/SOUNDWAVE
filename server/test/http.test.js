import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../app.js";
import { openDatabase, seedDatabase } from "../db.js";
test("request IDs and structured logs cover successful and invalid requests without logging bodies", async () => {
  const db = openDatabase(":memory:");
  seedDatabase(db);
  const logs = [];
  try {
    const app = createApp(db, { logger: (record) => logs.push(record) });
    const ok = await request(app).get("/api/health").expect(200);
    const bad = await request(app).get("/api/stories/bad").expect(400);
    assert.match(ok.headers["x-request-id"], /^[0-9a-f-]{36}$/);
    assert.notEqual(ok.headers["x-request-id"], bad.headers["x-request-id"]);
    assert.equal(logs.length, 2);
    assert.equal(logs[1].status, 400);
    assert.equal(logs[0].requestId, ok.headers["x-request-id"]);
    assert.ok(logs[0].durationMs >= 0);
    assert.equal(logs[0].body, undefined);
  } finally {
    db.close();
  }
});
test("API rate limit returns 429 with retry headers while media ranges remain usable", async () => {
  const db = openDatabase(":memory:");
  seedDatabase(db);
  try {
    const app = createApp(db, { rateLimit: { max: 2, windowMs: 60000 } });
    await request(app).get("/api/health").expect(200);
    await request(app).get("/api/health").expect(200);
    const limited = await request(app).get("/api/health").expect(429);
    assert.equal(limited.headers["ratelimit-remaining"], "0");
    assert.ok(Number(limited.headers["retry-after"]) > 0);
    assert.equal(typeof limited.body.error.message, "string");
    await request(app)
      .get("/api/chapters/101/stream")
      .set("Range", "bytes=0-9")
      .expect(206);
  } finally {
    db.close();
  }
});

test("CORS permits configured development origin but never reflects an arbitrary site or credentials", async () => {
  const db = openDatabase(":memory:");
  seedDatabase(db);
  try {
    const app = createApp(db);
    const denied = await request(app)
      .get("/api/health")
      .set("Origin", "https://untrusted.example")
      .expect(200);
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
    assert.equal(denied.headers["access-control-allow-credentials"], undefined);
    const preflight = await request(app)
      .options("/api/progress/101")
      .set("Origin", "https://untrusted.example")
      .set("Access-Control-Request-Method", "PUT");
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  } finally {
    db.close();
  }
});
test("oversized JSON and malformed URI requests return bounded JSON errors without stack disclosure", async () => {
  const db = openDatabase(":memory:");
  seedDatabase(db);
  try {
    const app = createApp(db);
    const big = await request(app)
      .put("/api/progress/101")
      .send({ positionSeconds: 5, padding: "x".repeat(9000) })
      .expect(413);
    assert.equal(typeof big.body.error.message, "string");
    assert.equal(big.body.error.stack, undefined);
    const malformed = await request(app)
      .get("/api/stories/%E0%A4%A")
      .expect(400);
    assert.equal(typeof malformed.body.error.message, "string");
  } finally {
    db.close();
  }
});
test("client-supplied forwarding headers cannot bypass the direct-server rate limit", async () => {
  const db = openDatabase(":memory:");
  seedDatabase(db);
  try {
    const app = createApp(db, { rateLimit: { max: 2, windowMs: 60000 } });
    for (let i = 0; i < 3; i++)
      await request(app)
        .get("/api/health")
        .set("X-Forwarded-For", `203.0.113.${i + 1}`)
        .expect(i < 2 ? 200 : 429);
  } finally {
    db.close();
  }
});
