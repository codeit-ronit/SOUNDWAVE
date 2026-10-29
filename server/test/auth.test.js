import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { openDatabase, seedDatabase } from "../db.js";
import { sqliteAdapter, postgresAdapter } from "../database/adapter.js";
import { migrate } from "../database/migrate.js";
import { seedCatalog } from "../database/seed.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import pg from "pg";
const config = loadConfig({ APP_ORIGIN: "http://localhost:3001" });
const password = "correct horse battery staple!";
async function fixture(kind) {
  let db, admin, schema;
  if (kind === "postgres") {
    admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    schema = "test_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = postgresAdapter(process.env.TEST_DATABASE_URL, { schema });
    await migrate(db);
    await seedCatalog(db);
  } else {
    const raw = openDatabase(":memory:");
    seedDatabase(raw);
    db = sqliteAdapter(raw);
  }
  const app = createApp(db, { config });
  async function client() {
    const agent = request.agent(app);
    let session = (await agent.get("/api/auth/session").expect(200)).body;
    return {
      agent,
      get data() {
        return session;
      },
      async auth(action, body) {
        const response = await agent
          .post("/api/auth/" + action)
          .set("X-CSRF-Token", session.csrfToken)
          .send(body);
        if (response.status === 200) session = response.body;
        return response;
      },
      write(method, path, body, csrf = session.csrfToken) {
        return agent[method]("/api" + path)
          .set("X-CSRF-Token", csrf)
          .send(body);
      },
      get: (path) => agent.get("/api" + path),
    };
  }
  return {
    app,
    db,
    client,
    close: async () => {
      await db.close();
      if (admin) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    },
  };
}
const backends = [
  "sqlite",
  ...(process.env.TEST_DATABASE_URL ? ["postgres"] : []),
];
for (const backend of backends) {
  async function run(fn) {
    const f = await fixture(backend);
    try {
      await fn(f);
    } finally {
      await f.close();
    }
  }
  test(`${backend}: registration, password hash, cookie attributes, normalization and session rotation`, () =>
    run(async ({ db, client }) => {
      const a = await client();
      const old = a.data.csrfToken;
      const result = await a.auth("register", {
        email: "Alice@Example.com",
        password,
        displayName: "Alice",
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.user.email, "alice@example.com");
      assert.equal(result.body.user.password_hash, undefined);
      assert.notEqual(a.data.csrfToken, old);
      assert.match(result.headers["set-cookie"][0], /HttpOnly/);
      assert.match(result.headers["set-cookie"][0], /SameSite=Lax/);
      const user = await db
        .prepare("SELECT * FROM users WHERE email=?")
        .get("alice@example.com");
      assert.match(user.password_hash, /^scrypt\$131072\$8\$1\$/);
      assert.ok(!user.password_hash.includes(password));
      await a.get("/library").expect(200);
      await a.write("put", "/library/1", {}, old).expect(403);
      const duplicate = await client();
      assert.equal(
        (
          await duplicate.auth("register", {
            email: "ALICE@example.com",
            password,
            displayName: "Dup",
          })
        ).status,
        409,
      );
    }));
  test(`${backend}: login, logout, revocation, invalid and expired cookies`, () =>
    run(async ({ app, db, client }) => {
      const a = await client();
      await a.auth("register", {
        email: "alice@example.com",
        password,
        displayName: "Alice",
      });
      const b = await client();
      assert.equal(
        (
          await b.auth("login", {
            email: "alice@example.com",
            password: "incorrect password!",
          })
        ).status,
        401,
      );
      const login = await b.auth("login", {
        email: "alice@example.com",
        password,
      });
      assert.equal(login.status, 200);
      const oldCookie = login.headers["set-cookie"][0].split(";")[0];
      const rawToken = oldCookie.split("=")[1];
      const hashes = await db
        .prepare("SELECT token_hash FROM sessions WHERE user_id=?")
        .all(a.data.user.id);
      assert.ok(
        hashes.length > 0 && hashes.every((row) => row.token_hash !== rawToken),
      );
      const cookie = (await b.get("/auth/session")).headers["set-cookie"];
      assert.equal(cookie, undefined);
      const saved = await b.get("/progress");
      assert.equal(saved.status, 200);
      assert.equal((await b.auth("logout")).status, 204);
      await b.get("/progress").expect(401);
      await request(app)
        .get("/api/progress")
        .set("Cookie", oldCookie)
        .expect(401);
      await a.write("put", "/library/1").expect(200);
      await db
        .prepare("UPDATE sessions SET expires_at=? WHERE user_id=?")
        .run("2000-01-01T00:00:00.000Z", a.data.user.id);
      await a.get("/progress").expect(401);
      await a.get("/auth/session").expect(401);
      await request(app)
        .get("/api/library")
        .set("Cookie", "soundwave-session=forged")
        .expect(401);
    }));
  test(`${backend}: isolated users cannot read or mutate favorites, progress, analytics or recommendations`, () =>
    run(async ({ client }) => {
      const a = await client(),
        b = await client();
      await a.auth("register", {
        email: "alice@example.com",
        password,
        displayName: "Alice",
      });
      await b.auth("register", {
        email: "bob@example.com",
        password,
        displayName: "Bob",
      });
      await a.write("put", "/library/1").expect(200);
      await a.write("put", "/progress/101", { positionSeconds: 8 }).expect(200);
      const id = randomUUID();
      const event = {
        id,
        type: "listening_interval",
        chapterId: 101,
        listeningSeconds: 5,
      };
      await a.write("post", "/analytics/events", event).expect(201);
      assert.equal(
        (await b.get("/library?userId=" + a.data.user.id)).body.stories.length,
        0,
      );
      assert.equal((await b.get("/progress")).body.progress.length, 0);
      assert.equal(
        (await b.get("/analytics/overview")).body.totalListeningSeconds,
        0,
      );
      assert.equal((await b.get("/stories/1")).body.story.is_favorite, false);
      assert.equal(
        (await b.get("/stories/1/chapters")).body.chapters[0].position_seconds,
        0,
      );
      assert.ok(
        (await a.get("/recommendations")).body.stories.every((s) => s.id !== 1),
      );
      assert.ok(
        (await b.get("/recommendations")).body.stories.some((s) => s.id === 1),
      );
      await b.write("delete", "/library/1").expect(204);
      await b.write("put", "/progress/101", { positionSeconds: 2 }).expect(200);
      await b
        .write("put", "/progress/101", {
          positionSeconds: 4,
          userId: a.data.user.id,
        })
        .expect(400);
      await b
        .write("post", "/analytics/events", {
          ...event,
          userId: a.data.user.id,
        })
        .expect(400);
      // Idempotency belongs to the owner, not a globally shared event namespace.
      await b.write("post", "/analytics/events", event).expect(201);
      await b.write("post", "/analytics/events", event).expect(200);
      assert.equal(
        (await a.get("/progress")).body.progress[0].position_seconds,
        8,
      );
      assert.equal((await a.get("/library")).body.stories.length, 1);
      assert.equal(
        (await a.get("/analytics/overview")).body.totalListeningSeconds,
        5,
      );
      await b.get("/library").set("X-Session-User", a.data.user.id).expect(409);
    }));
  test(`${backend}: CSRF, origin checks and public catalog/media access`, () =>
    run(async ({ app, client }) => {
      await request(app).get("/api/stories?q=MYSTERY&sort=title").expect(200);
      await request(app)
        .get("/api/chapters/101/stream")
        .set("Range", "bytes=0-99")
        .expect(206);
      await request(app)
        .get("/api/chapters/101/stream")
        .set("Range", "bytes=999999999-")
        .expect(416);
      const a = await client();
      await a.auth("demo");
      await a.write("put", "/library/1", {}, "bad").expect(403);
      await a.write("put", "/library/1", {}, "é".repeat(64)).expect(403);
      await a
        .write("put", "/library/1")
        .set("Origin", "https://evil.example")
        .expect(403);
      await a
        .write("put", "/library/1")
        .set("Sec-Fetch-Site", "cross-site")
        .expect(403);
      await a
        .write("put", "/library/1")
        .set("Origin", "http://localhost:3001")
        .expect(200);
      const r = await a.get("/library");
      assert.match(r.headers["cache-control"], /no-store/);
      assert.match(r.headers.vary, /Cookie/);
      await a.agent
        .post("/api/auth/login")
        .send({ email: "a@a.com", password })
        .expect(403);
    }));
  test(`${backend}: guest sessions are isolated and cannot select a registered/legacy user`, () =>
    run(async ({ client, app, db }) => {
      const a = await client(),
        b = await client();
      await a.auth("demo");
      await b.auth("demo");
      assert.notEqual(a.data.user.id, b.data.user.id);
      assert.notEqual(a.data.user.id, "demo-user");
      await a.write("put", "/library/1").expect(200);
      assert.equal((await b.get("/library")).body.stories.length, 0);
      const disabled = createApp(db, {
        config: { ...config, demoEnabled: false },
      });
      const visitor = request.agent(disabled);
      const s = (await visitor.get("/api/auth/session")).body;
      await visitor
        .post("/api/auth/demo")
        .set("X-CSRF-Token", s.csrfToken)
        .expect(403);
      await visitor.get("/api/library").expect(401);
      await request(app)
        .get("/api/library")
        .set("X-User-ID", "demo-user")
        .expect(401);
    }));
  test(`${backend}: invalid registration input and login throttling`, () =>
    run(async ({ app, db, client }) => {
      const a = await client();
      for (const body of [
        { email: "bad", password, displayName: "A" },
        { email: "a@b.com", password: "short", displayName: "A" },
        { email: "a@b.com", password, displayName: "A", userId: "demo-user" },
      ])
        assert.equal((await a.auth("register", body)).status, 400);
      const limited = createApp(db, {
        config,
        authLimit: { max: 1, windowMs: 60000 },
      });
      const agent = request.agent(limited);
      const s = (await agent.get("/api/auth/session")).body;
      await agent
        .post("/api/auth/login")
        .set("X-CSRF-Token", s.csrfToken)
        .send({ email: "a@b.com", password })
        .expect(401);
      await agent
        .post("/api/auth/login")
        .set("X-CSRF-Token", s.csrfToken)
        .send({ email: "a@b.com", password })
        .expect(429);
    }));
  test(`${backend}: transaction rollback, concurrent completions and stale progress writes`, () =>
    run(async ({ db, client }) => {
      const a = await client();
      await a.auth("demo");
      const user = a.data.user.id;
      await assert.rejects(
        db.transaction(async () => {
          await db
            .prepare("INSERT INTO favorites(user_id,story_id) VALUES(?,?)")
            .run(user, 1);
          throw Error("rollback fixture");
        }),
      );
      assert.equal((await a.get("/library")).body.stories.length, 0);
      const duration = (await a.get("/stories/1/chapters")).body.chapters[0]
        .duration_seconds;
      const clientId = randomUUID();
      await Promise.all(
        [1, 2, 3].map((sequence) =>
          a
            .write("put", "/progress/101", {
              positionSeconds: duration,
              completed: true,
              clientId,
              sequence,
            })
            .expect(200),
        ),
      );
      await a
        .write("put", "/progress/101", {
          positionSeconds: 0,
          clientId,
          sequence: 1,
        })
        .expect(200);
      const overview = (await a.get("/analytics/overview")).body;
      assert.equal(overview.completedChapters, 1);
      assert.equal(
        overview.recentActivity.filter(
          (e) => e.event_type === "chapter_completed",
        ).length,
        1,
      );
    }));
  test(`${backend}: migration checksums, rerun safety, constraints and preserved rows`, () =>
    run(async ({ db, client }) => {
      const a = await client();
      await a.auth("demo");
      await a.write("put", "/library/1").expect(200);
      await migrate(db);
      await seedCatalog(db);
      assert.equal((await a.get("/library")).body.stories.length, 1);
      if (backend === "postgres")
        await assert.rejects(
          db
            .prepare("INSERT INTO favorites(user_id,story_id) VALUES(?,?)")
            .run("missing-user", 1),
        );
      assert.equal(
        (await db.prepare("SELECT COUNT(*) AS count FROM stories").get()).count,
        6,
      );
      await db
        .prepare("UPDATE schema_migrations SET checksum=? WHERE version=?")
        .run(
          "tampered",
          backend === "postgres" ? "001_core.sql" : "001_auth.sql",
        );
      await assert.rejects(migrate(db), /checksum mismatch/);
    }));
}
test("production configuration requires HTTPS and uses host-only secure cookies", async () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /HTTPS/);
  const production = loadConfig({
    NODE_ENV: "production",
    APP_ORIGIN: "https://soundwave.example",
  });
  const raw = openDatabase(":memory:");
  seedDatabase(raw);
  try {
    const app = createApp(raw, { config: production });
    const res = await request(app).get("/api/auth/session").expect(200);
    assert.match(res.headers["set-cookie"][0], /^__Host-soundwave=/);
    assert.match(res.headers["set-cookie"][0], /; Secure/);
    assert.ok(!/Domain=/.test(res.headers["set-cookie"][0]));
  } finally {
    raw.close();
  }
});

for (const backend of backends) {
  test(`${backend}: guest registration preserves library, progress and analytics`, async () => {
    const f = await fixture(backend);
    try {
      const a = await f.client();
      await a.auth("demo");
      const id = a.data.user.id;
      await a.write("put", "/library/1").expect(200);
      await a.write("put", "/progress/101", { positionSeconds: 7 }).expect(200);
      assert.equal(
        (
          await a.auth("register", {
            email: "upgrade@example.com",
            password,
            displayName: "Upgraded",
          })
        ).status,
        200,
      );
      assert.equal(a.data.user.id, id);
      assert.equal(a.data.user.kind, "registered");
      assert.equal((await a.get("/library")).body.stories.length, 1);
      assert.equal(
        (await a.get("/progress")).body.progress[0].position_seconds,
        7,
      );
      assert.equal(
        (await a.get("/analytics/overview")).body.favoriteStories,
        1,
      );
      await a.auth("logout");
      const b = await f.client();
      await b.auth("login", { email: "upgrade@example.com", password });
      assert.equal(
        (await b.get("/progress")).body.progress[0].position_seconds,
        7,
      );
    } finally {
      await f.close();
    }
  });
}
