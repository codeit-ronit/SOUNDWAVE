import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, backends, password } from "./phase2-helpers.js";
import { accountService } from "../services/account.js";
import { migrate } from "../database/migrate.js";
import { jobHandlers } from "../jobs/handlers.js";
import { redisInfrastructure } from "../infrastructure/redis.js";
async function guest(f) {
  const c = await f.client();
  await c.auth("demo");
  return c;
}
const defaults = {
  playbackSpeed: 1,
  autoplayNext: true,
  defaultVolume: 0.8,
  updatedAt: null,
};
for (const kind of backends) {
  test(`${kind}: profile edits expose only safe identity fields and retain the session`, async () => {
    const f = await fixture(kind);
    try {
      const c = await guest(f),
        before = c.data;
      const p = await c.get("/profile").expect(200);
      assert.deepEqual(
        Object.keys(p.body.profile).sort(),
        [
          "displayName",
          "email",
          "emailVerified",
          "googleLinked",
          "id",
          "kind",
        ].sort(),
      );
      assert.equal(p.body.profile.email, null);
      assert.equal(p.body.profile.googleLinked, false);
      assert.match(p.headers["cache-control"], /private, no-store/);
      assert.match(p.headers.vary, /Cookie/);
      const renamed = await c
        .write("put", "/profile", { displayName: "  Listener's <name> 🎧  " })
        .expect(200);
      assert.equal(renamed.body.profile.displayName, "Listener's <name> 🎧");
      const after = (await c.get("/auth/session").expect(200)).body;
      assert.equal(after.csrfToken, before.csrfToken);
      assert.equal(after.user.id, before.user.id);
      assert.equal(after.user.displayName, renamed.body.profile.displayName);
      await c.write("put", "/library/1").expect(200);
      assert.equal((await c.get("/library")).body.stories.length, 1);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: settings have safe lazy defaults, partial updates and immutable identity`, async () => {
    const f = await fixture(kind);
    try {
      const c = await guest(f);
      assert.deepEqual(
        (await c.get("/settings").expect(200)).body.settings,
        defaults,
      );
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM user_preferences").get())
          .n,
        0,
      );
      await c
        .write("put", "/settings", { playbackSpeed: 1.5, defaultVolume: 0.3 })
        .expect(200);
      const changed = (
        await c.write("put", "/settings", { autoplayNext: false }).expect(200)
      ).body.settings;
      assert.equal(changed.playbackSpeed, 1.5);
      assert.equal(changed.defaultVolume, 0.3);
      assert.equal(changed.autoplayNext, false);
      assert.ok(changed.updatedAt);
      await c.write("put", "/settings", { defaultVolume: 0 }).expect(200);
      assert.equal((await c.get("/settings")).body.settings.defaultVolume, 0);
      await c.write("put", "/settings", { defaultVolume: 1 }).expect(200);
      assert.equal((await c.get("/settings")).body.settings.defaultVolume, 1);
      assert.deepEqual((await c.get("/profile")).body.profile, c.data.user);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: profile/settings reject forged owners, identities, invalid input, CSRF and anonymous sessions`, async () => {
    const f = await fixture(kind);
    try {
      const a = await guest(f),
        b = await guest(f),
        anon = await f.client();
      for (const path of ["/profile", "/settings"]) {
        await anon.get(path).expect(401);
        await anon
          .write(
            "put",
            path,
            path === "/profile" ? { displayName: "x" } : { playbackSpeed: 2 },
          )
          .expect(401);
        await a.get(path + "?userId=" + b.data.user.id).expect(400);
        await a
          .write(
            "put",
            path + "?userId=" + b.data.user.id,
            path === "/profile" ? { displayName: "x" } : { playbackSpeed: 2 },
          )
          .expect(400);
        await a.get(path + "/" + b.data.user.id).expect(404);
      }
      for (const body of [
        {},
        [],
        { displayName: " " },
        { displayName: 1 },
        { displayName: "x".repeat(81) },
        { displayName: "x\n" },
        { displayName: "x", email: "attacker@example.com" },
        { displayName: "x", userId: b.data.user.id },
        { displayName: "x", googleLinked: true },
        { displayName: "x", subject: "changed" },
      ])
        await a.write("put", "/profile", body).expect(400);
      for (const body of [
        {},
        [],
        { playbackSpeed: "1.5" },
        { playbackSpeed: 3 },
        { autoplayNext: 1 },
        { defaultVolume: null },
        { defaultVolume: -0.1 },
        { defaultVolume: 1.1 },
        { defaultVolume: "0.5" },
        { playbackSpeed: 2, user_id: b.data.user.id },
      ])
        await a.write("put", "/settings", body).expect(400);
      await a.agent
        .put("/api/profile")
        .send({ displayName: "No CSRF" })
        .expect(403);
      await a.agent
        .put("/api/settings")
        .set("X-CSRF-Token", a.data.csrfToken)
        .set("Origin", "https://evil.example")
        .send({ playbackSpeed: 2 })
        .expect(403);
      await a.agent
        .get("/api/settings")
        .set("X-Session-User", b.data.user.id)
        .expect(409);
      await a
        .write("put", "/profile", { displayName: "🎧".repeat(80) })
        .expect(200);
      await a.auth("logout");
      await a.get("/profile").expect(401);
      await a.get("/settings").expect(401);
      assert.deepEqual((await b.get("/settings")).body.settings, defaults);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: settings survive guest upgrade and independent logins without leaking between users`, async () => {
    const f = await fixture(kind);
    try {
      const a = await guest(f),
        b = await guest(f),
        id = a.data.user.id,
        email = randomUUID() + "@example.com";
      await a
        .write("put", "/settings", {
          playbackSpeed: 1.25,
          autoplayNext: false,
          defaultVolume: 0.4,
        })
        .expect(200);
      await a.auth("register", {
        email,
        password,
        displayName: "Registered listener",
      });
      assert.equal(a.data.user.id, id);
      await a
        .write("put", "/profile", { displayName: "New display name" })
        .expect(200);
      const second = await f.client();
      assert.equal(
        (await second.auth("login", { email, password })).status,
        200,
      );
      assert.equal(
        (await second.get("/profile")).body.profile.displayName,
        "New display name",
      );
      assert.equal((await second.get("/profile")).body.profile.email, email);
      assert.equal(
        (await second.get("/settings")).body.settings.playbackSpeed,
        1.25,
      );
      await second
        .write("put", "/settings", { defaultVolume: 0.2 })
        .expect(200);
      assert.equal((await a.get("/settings")).body.settings.defaultVolume, 0.2);
      assert.deepEqual((await b.get("/settings")).body.settings, defaults);
      await a.auth("logout");
      const returning = await f.client();
      await returning.auth("login", { email, password });
      assert.equal(
        (await returning.get("/settings")).body.settings.autoplayNext,
        false,
      );
    } finally {
      await f.close();
    }
  });
  test(`${kind}: account writes serialize concurrent field changes and roll back atomically`, async () => {
    const f = await fixture(kind);
    try {
      const a = await guest(f),
        id = a.data.user.id,
        s = accountService(f.db);
      await Promise.all([
        a.write("put", "/settings", { playbackSpeed: 2 }).expect(200),
        a.write("put", "/settings", { autoplayNext: false }).expect(200),
        a.write("put", "/settings", { defaultVolume: 0.6 }).expect(200),
      ]);
      const settings = (await a.get("/settings")).body.settings;
      assert.equal(settings.playbackSpeed, 2);
      assert.equal(settings.autoplayNext, false);
      assert.equal(settings.defaultVolume, 0.6);
      await assert.rejects(
        f.db.transaction(async () => {
          await s.rename(id, "Rolled back");
          await s.saveSettings(id, { playbackSpeed: 0.75 });
          throw Error("rollback account");
        }),
        /rollback account/,
      );
      assert.equal(
        (await a.get("/profile")).body.profile.displayName,
        "Demo listener",
      );
      assert.deepEqual((await a.get("/settings")).body.settings, settings);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: additive preferences migrations preserve existing listener rows and enforce constraints/cascades`, async () => {
    const f = await fixture(kind);
    try {
      const a = await guest(f),
        id = a.data.user.id;
      await a.write("put", "/library/1").expect(200);
      await a.write("put", "/progress/101", { positionSeconds: 8 }).expect(200);
      const version =
        kind === "postgres"
          ? "010_user_preferences.sql"
          : "011_user_preferences.sql";
      // Rewind only this generated fixture to the actual previous schema.
      await f.db.prepare("DROP TABLE user_preferences").run();
      await f.db
        .prepare("DELETE FROM schema_migrations WHERE version=?")
        .run(version);
      await migrate(f.db);
      await migrate(f.db);
      assert.equal((await a.get("/library")).body.stories[0].id, 1);
      assert.equal(
        (await a.get("/progress")).body.progress[0].position_seconds,
        8,
      );
      assert.deepEqual((await a.get("/settings")).body.settings, defaults);
      await assert.rejects(
        f.db
          .prepare(
            "INSERT INTO user_preferences(user_id,playback_speed) VALUES(?,?)",
          )
          .run(id, 3),
      );
      await assert.rejects(
        f.db
          .prepare(
            "INSERT INTO user_preferences(user_id,autoplay_next) VALUES(?,?)",
          )
          .run(id, 2),
      );
      await assert.rejects(
        f.db
          .prepare(
            "INSERT INTO user_preferences(user_id,default_volume) VALUES(?,?)",
          )
          .run(id, 2),
      );
      await assert.rejects(
        f.db
          .prepare("INSERT INTO user_preferences(user_id) VALUES(?)")
          .run("missing"),
      );
      await a.write("put", "/settings", { playbackSpeed: 1.5 }).expect(200);
      await f.db
        .prepare("UPDATE users SET created_at=? WHERE id=?")
        .run("2000-01-01T00:00:00.000Z", id);
      await f.db
        .prepare("UPDATE sessions SET expires_at=? WHERE user_id=?")
        .run("2000-01-01T00:00:00.000Z", id);
      await f.db.transaction(() => jobHandlers(f.db).maintenance());
      assert.equal(
        await f.db
          .prepare("SELECT user_id FROM user_preferences WHERE user_id=?")
          .get(id),
        undefined,
      );
    } finally {
      await f.close();
    }
  });
  if (process.env.TEST_REDIS_URL)
    test(`${kind}: private profile/settings reads never populate shared Redis catalog cache`, async () => {
      const redis = redisInfrastructure(process.env.TEST_REDIS_URL, {
          prefix: "account-" + randomUUID(),
        }),
        f = await fixture(kind, {
          redis,
          config: { catalogCacheEnabled: true },
        });
      try {
        await redis.client.connect();
        const a = await guest(f);
        await a.get("/stories").expect(200);
        const before = redis.cacheStats();
        await a.get("/profile").expect(200);
        await a.get("/settings").expect(200);
        await a.write("put", "/settings", { playbackSpeed: 2 }).expect(200);
        await a
          .write("put", "/profile", { displayName: "Private name" })
          .expect(200);
        assert.deepEqual(redis.cacheStats(), before);
      } finally {
        await redis.close();
        await f.close();
      }
    });
}
