import { progressBody } from "./progress-body.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { backends, fixture, password } from "./phase2-helpers.js";
import { playlistService } from "../services/playlists.js";
import { migrate } from "../database/migrate.js";
import { jobHandlers } from "../jobs/handlers.js";
import { redisInfrastructure } from "../infrastructure/redis.js";

async function listener(f) {
  const c = await f.client();
  await c.auth("demo");
  return c;
}
async function create(c, name = "Evening stories") {
  return (await c.write("post", "/playlists", { name }).expect(201)).body
    .playlist;
}
async function stories(db, count = 101) {
  for (let i = 0; i < count; i++)
    await db
      .prepare(
        `INSERT INTO stories(id,title,genre,author,tagline,description,color,symbol,popularity)
    SELECT ?,title,genre,author,tagline,description,color,symbol,popularity FROM stories WHERE id=1`,
      )
      .run(10000 + i);
}

for (const kind of backends) {
  test(`${kind}: playlist CRUD, stable membership order, private headers and favorites stay independent`, async () => {
    const f = await fixture(kind);
    try {
      const c = await listener(f),
        p = await create(c, "  Night's <stories>  ");
      assert.equal(p.name, "Night's <stories>");
      assert.equal(p.storyCount, 0);
      assert.equal(Object.hasOwn(p, "user_id"), false);
      const listing = await c.get("/playlists").expect(200);
      assert.match(listing.headers["cache-control"], /private, no-store/);
      assert.match(listing.headers.vary, /Cookie/);
      assert.equal(listing.body.nextCursor, null);
      await c.write("put", `/playlists/${p.id}/stories/3`).expect(200);
      await c.write("put", `/playlists/${p.id}/stories/1`).expect(200);
      const added = (await c.get(`/playlists/${p.id}`).expect(200)).body;
      assert.deepEqual(
        added.stories.map((s) => s.id),
        [3, 1],
      );
      assert.equal(added.playlist.storyCount, 2);
      assert.equal((await c.get("/library")).body.stories.length, 0);
      const insights = (await c.get("/analytics/overview").expect(200)).body;
      assert.equal(insights.favoriteStories, 0);
      assert.equal(insights.totalListeningSeconds, 0);
      assert.equal(insights.recentActivity.length, 0);
      assert.equal(
        (await c.get("/recommendations").expect(200)).body.strategy,
        "rule-based",
      );
      await c.write("put", "/library/1").expect(200);
      assert.equal(
        (await c.get(`/playlists/${p.id}`)).body.stories[1].is_favorite,
        true,
      );
      const repeated = await c
        .write("put", `/playlists/${p.id}/stories/3`)
        .expect(200);
      assert.equal(repeated.body.playlist.storyCount, 2);
      await c.write("delete", `/playlists/${p.id}/stories/3`).expect(204);
      await c.write("delete", `/playlists/${p.id}/stories/3`).expect(204);
      await c.write("put", `/playlists/${p.id}/stories/3`).expect(200);
      assert.deepEqual(
        (await c.get(`/playlists/${p.id}`)).body.stories.map((s) => s.id),
        [1, 3],
      );
      await c
        .write("put", `/playlists/${p.id}`, { name: "Renamed" })
        .expect(200);
      assert.equal(
        (await c.get("/playlists")).body.playlists[0].name,
        "Renamed",
      );
      await c.write("delete", `/playlists/${p.id}`).expect(204);
      await c.get(`/playlists/${p.id}`).expect(404);
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM playlist_items").get())
          .n,
        0,
      );
      assert.equal((await c.get("/library")).body.stories.length, 1);
    } finally {
      await f.close();
    }
  });

  if (process.env.TEST_REDIS_URL)
    test(`${kind}: private playlists never enter shared Redis catalog cache`, async () => {
      const redis = redisInfrastructure(process.env.TEST_REDIS_URL, {
        prefix: "playlists-" + randomUUID(),
      });
      const f = await fixture(kind, {
        redis,
        config: { catalogCacheEnabled: true },
      });
      try {
        await redis.client.connect();
        const c = await listener(f);
        await c.get("/stories").expect(200);
        const before = redis.cacheStats(),
          name = "private-collection-" + randomUUID(),
          p = await create(c, name);
        await c.write("put", `/playlists/${p.id}/stories/1`).expect(200);
        await c.get("/playlists").expect(200);
        await c.get(`/playlists/${p.id}`).expect(200);
        assert.deepEqual(redis.cacheStats(), before);
        let inspected = 0;
        for await (const keys of redis.client.scanIterator({
          MATCH: redis.prefix + ":catalog:*",
        })) {
          if (!keys.length) continue; // SCAN may yield empty batches before completion.
          inspected += keys.length;
          for (const value of await redis.client.mGet(keys))
            assert.ok(!value?.includes(name));
        }
        assert.ok(inspected > 0);
      } finally {
        await redis.close();
        await f.close();
      }
    });

  test(`${kind}: playlist reads/writes reject anonymous sessions, forged owner fields and other users' IDs`, async () => {
    const f = await fixture(kind);
    try {
      const a = await listener(f),
        b = await listener(f),
        anon = await f.client(),
        p = await create(a);
      await anon.get("/playlists").expect(401);
      await anon.get(`/playlists/${p.id}`).expect(401);
      await anon.write("post", "/playlists", { name: "No" }).expect(401);
      await anon.write("put", `/playlists/${p.id}/stories/1`).expect(401);
      assert.deepEqual((await b.get("/playlists")).body.playlists, []);
      for (const c of [b]) {
        for (const path of [
          `/playlists/${p.id}`,
          `/playlists/${randomUUID()}`,
        ]) {
          const missing = await c.get(path).expect(404);
          assert.equal(missing.body.error.code, "PLAYLIST_NOT_FOUND");
          await c.write("put", path, { name: "Stolen" }).expect(404);
          await c.write("delete", path).expect(404);
          await c.write("put", path + "/stories/1").expect(404);
          await c.write("delete", path + "/stories/1").expect(404);
        }
      }
      await b
        .write("post", "/playlists", {
          name: "Forged",
          user_id: a.data.user.id,
        })
        .expect(400);
      await a
        .write("put", `/playlists/${p.id}`, {
          name: "Forged",
          ownerId: b.data.user.id,
        })
        .expect(400);
      await a
        .write("put", `/playlists/${p.id}/stories/1`, {
          userId: b.data.user.id,
        })
        .expect(400);
      await b.agent
        .get(`/api/playlists/${p.id}`)
        .set("X-Session-User", a.data.user.id)
        .expect(409);
      await a.agent
        .put(`/api/playlists/${p.id}`)
        .send({ name: "No CSRF" })
        .expect(403);
      await a.agent
        .delete(`/api/playlists/${p.id}`)
        .set("X-CSRF-Token", a.data.csrfToken)
        .set("Origin", "https://evil.example")
        .expect(403);
      await a.auth("logout");
      await a.get(`/playlists/${p.id}`).expect(401);
    } finally {
      await f.close();
    }
  });

  test(`${kind}: playlist validation handles malformed names, identifiers, bodies, stories and cursors`, async () => {
    const f = await fixture(kind);
    try {
      const c = await listener(f),
        p = await create(c);
      for (const body of [
        {},
        [],
        { name: null },
        { name: 1 },
        { name: " " },
        { name: "a".repeat(81) },
        { name: "a\nb" },
        { name: "a\u0000" },
        { name: "x", id: randomUUID() },
      ]) {
        const error = await c.write("post", "/playlists", body).expect(400);
        assert.equal(error.body.error.code, "INVALID_PLAYLIST_REQUEST");
        await c.write("put", `/playlists/${p.id}`, body).expect(400);
      }
      await create(c, "🎧".repeat(80));
      for (const id of ["0", "1", "not-a-uuid", "' OR 1=1 --"])
        await c.get(`/playlists/${encodeURIComponent(id)}`).expect(400);
      for (const id of ["0", "-1", "1.5", "bad", "9999999999"])
        await c.write("put", `/playlists/${p.id}/stories/${id}`).expect(400);
      await c.write("put", `/playlists/${p.id}/stories/99999999`).expect(404);
      await c.write("put", `/playlists/${p.id}/stories/1`, [1]).expect(400);
      await c
        .write("delete", `/playlists/${p.id}`, { name: "ignored?" })
        .expect(400);
      for (const query of [
        "limit=0",
        "limit=51",
        "limit=-1",
        "limit=1.5",
        "limit=1&limit=2",
        "limit=01",
        "cursor=garbage",
        "cursor=",
        "ownerId=x",
      ])
        await c.get(`/playlists?${query}`).expect(400);
      const badCursor = Buffer.from(
        JSON.stringify({ at: "0000-01-01T00:00:00.000Z", id: p.id }),
      ).toString("base64url");
      await c.get(`/playlists?cursor=${badCursor}`).expect(400);
      assert.equal(
        (await c.get(`/playlists/${p.id}`)).body.playlist.storyCount,
        0,
      );
    } finally {
      await f.close();
    }
  });

  test(`${kind}: keyset pagination enforces 20/50 limits with timestamp ties, deletion and foreign cursors`, async () => {
    const f = await fixture(kind);
    try {
      const c = await listener(f),
        other = await listener(f),
        service = playlistService(f.db);
      for (let i = 0; i < 53; i++)
        await service.create(c.data.user.id, "List " + i);
      await f.db
        .prepare("UPDATE playlists SET created_at=? WHERE user_id=?")
        .run("2026-01-01T00:00:00.000Z", c.data.user.id);
      const first = (await c.get("/playlists").expect(200)).body;
      assert.equal(first.playlists.length, 20);
      assert.ok(first.nextCursor);
      const max = (await c.get("/playlists?limit=50")).body;
      assert.equal(max.playlists.length, 50);
      await c
        .write("delete", `/playlists/${first.playlists.at(-1).id}`)
        .expect(204);
      let cursor = first.nextCursor,
        ids = first.playlists.map((p) => p.id);
      while (cursor) {
        const page = (await c.get(`/playlists?cursor=${cursor}`).expect(200))
          .body;
        ids.push(...page.playlists.map((p) => p.id));
        cursor = page.nextCursor;
      }
      assert.equal(ids.length, 53);
      assert.equal(new Set(ids).size, 53);
      const own = await create(other, "Other owner");
      const forged = (await other.get(`/playlists?cursor=${first.nextCursor}`))
        .body;
      assert.ok(forged.playlists.every((p) => p.id === own.id));
      assert.equal(
        (await c.get(`/playlists/${first.playlists[0].id.toUpperCase()}`))
          .status,
        200,
      );
    } finally {
      await f.close();
    }
  });

  test(`${kind}: concurrent playlist additions serialize the 100-story cap and duplicate writes`, async () => {
    const f = await fixture(kind);
    try {
      const c = await listener(f),
        p = await create(c),
        service = playlistService(f.db),
        user = c.data.user.id;
      await stories(f.db, 105);
      await f.db.transaction(async () => {
        for (let i = 0; i < 99; i++) await service.add(user, p.id, 10000 + i);
      });
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          c.write("put", `/playlists/${p.id}/stories/${10099 + i}`),
        ),
      );
      assert.equal(results.filter((r) => r.status === 200).length, 1);
      assert.equal(
        results.filter(
          (r) => r.status === 409 && r.body.error.code === "PLAYLIST_FULL",
        ).length,
        5,
      );
      assert.equal(
        (await c.get(`/playlists/${p.id}`)).body.playlist.storyCount,
        100,
      );
      await c.write("put", `/playlists/${p.id}/stories/10000`).expect(200);
      await c.write("delete", `/playlists/${p.id}/stories/10000`).expect(204);
      const duplicates = await Promise.all(
        Array.from({ length: 6 }, () =>
          c.write("put", `/playlists/${p.id}/stories/10000`),
        ),
      );
      assert.ok(duplicates.every((r) => r.status === 200));
      assert.equal(
        (await c.get(`/playlists/${p.id}`)).body.playlist.storyCount,
        100,
      );
      const rows = await f.db
        .prepare(
          "SELECT position FROM playlist_items WHERE playlist_id=? ORDER BY position",
        )
        .all(p.id);
      assert.equal(new Set(rows.map((r) => r.position)).size, 100);
      assert.equal(rows.at(-1).position, 101);
    } finally {
      await f.close();
    }
  });

  test(`${kind}: playlist transaction rollback undoes membership, order counters, rename and deletion`, async () => {
    const f = await fixture(kind);
    try {
      const c = await listener(f),
        p = await create(c),
        s = playlistService(f.db),
        user = c.data.user.id;
      await assert.rejects(
        f.db.transaction(async () => {
          await s.add(user, p.id, 1);
          await s.rename(user, p.id, "Not committed");
          throw Error("rollback fixture");
        }),
        /rollback fixture/,
      );
      assert.equal(
        (await c.get(`/playlists/${p.id}`)).body.playlist.name,
        p.name,
      );
      assert.equal((await c.get(`/playlists/${p.id}`)).body.stories.length, 0);
      assert.equal(
        (
          await f.db
            .prepare("SELECT next_position FROM playlists WHERE id=?")
            .get(p.id)
        ).next_position,
        1,
      );
      await s.add(user, p.id, 1);
      await assert.rejects(
        f.db.transaction(async () => {
          await s.remove(user, p.id);
          throw Error("rollback deletion");
        }),
        /rollback deletion/,
      );
      assert.equal((await c.get(`/playlists/${p.id}`)).body.stories.length, 1);
      const races = await Promise.all([
        c.write("put", `/playlists/${p.id}`, { name: "Concurrent rename" }),
        c.write("delete", `/playlists/${p.id}`),
      ]);
      assert.equal(races[1].status, 204);
      assert.ok([200, 404].includes(races[0].status));
      await c.get(`/playlists/${p.id}`).expect(404);
    } finally {
      await f.close();
    }
  });

  test(`${kind}: additive playlist migration preserves existing sessions/library/progress and enforces constraints`, async () => {
    const f = await fixture(kind);
    try {
      const c = await listener(f),
        user = c.data.user.id;
      await c.write("put", "/library/1").expect(200);
      await c
        .write(
          "put",
          "/progress/101",
          await progressBody(c, { positionSeconds: 9 }, "/progress/101"),
        )
        .expect(200);
      const version =
        kind === "postgres" ? "009_playlists.sql" : "010_playlists.sql";
      // Only this generated fixture is rewound to the pre-playlist schema.
      await f.db.prepare("DROP TABLE playlist_items").run();
      await f.db.prepare("DROP TABLE playlists").run();
      await f.db
        .prepare("DELETE FROM schema_migrations WHERE version=?")
        .run(version);
      await migrate(f.db);
      await migrate(f.db);
      assert.equal((await c.get("/library")).body.stories[0].id, 1);
      assert.equal(
        (await c.get("/progress")).body.progress[0].position_seconds,
        9,
      );
      const p = await create(c);
      await c.write("put", `/playlists/${p.id}/stories/1`).expect(200);
      await assert.rejects(
        f.db
          .prepare(
            "INSERT INTO playlist_items(playlist_id,story_id,position) VALUES(?,?,?)",
          )
          .run(p.id, 1, 2),
      );
      await assert.rejects(
        f.db
          .prepare(
            "INSERT INTO playlist_items(playlist_id,story_id,position) VALUES(?,?,?)",
          )
          .run(p.id, 2, 1),
      );
      await assert.rejects(
        f.db
          .prepare("INSERT INTO playlists(id,user_id,name) VALUES(?,?,?)")
          .run(randomUUID(), "missing-owner", "No owner"),
      );
      await assert.rejects(
        f.db
          .prepare("INSERT INTO playlists(id,user_id,name) VALUES(?,?,?)")
          .run(randomUUID(), user, " "),
      );
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT COUNT(*) AS n FROM schema_migrations WHERE version=?",
            )
            .get(version)
        ).n,
        1,
      );
    } finally {
      await f.close();
    }
  });

  test(`${kind}: playlists survive guest upgrade/password login, isolate account switching, and cascade expired guests`, async () => {
    const f = await fixture(kind);
    try {
      const c = await listener(f),
        p = await create(c),
        user = c.data.user.id,
        email = randomUUID() + "@example.com";
      await c.write("put", `/playlists/${p.id}/stories/1`).expect(200);
      const registered = await c.auth("register", {
        email,
        password,
        displayName: "Playlist listener",
      });
      assert.equal(registered.status, 200);
      assert.equal(c.data.user.id, user);
      await c.auth("logout");
      const signedOut = await f.client();
      await signedOut.auth("login", { email, password });
      assert.equal(
        (await signedOut.get(`/playlists/${p.id}`)).body.stories[0].id,
        1,
      );
      await signedOut.auth("logout");
      const switched = await listener(f);
      assert.deepEqual((await switched.get("/playlists")).body.playlists, []);
      await switched.get(`/playlists/${p.id}`).expect(404);
      const guest = await create(switched, "Expired guest");
      await switched
        .write("put", `/playlists/${guest.id}/stories/2`)
        .expect(200);
      await f.db
        .prepare("UPDATE users SET created_at=? WHERE id=?")
        .run("2000-01-01T00:00:00.000Z", switched.data.user.id);
      await f.db
        .prepare("UPDATE sessions SET expires_at=? WHERE user_id=?")
        .run("2000-01-01T00:00:00.000Z", switched.data.user.id);
      await f.db.transaction(() => jobHandlers(f.db).maintenance());
      assert.equal(
        await f.db.prepare("SELECT id FROM playlists WHERE id=?").get(guest.id),
        undefined,
      );
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id=?",
            )
            .get(guest.id)
        ).n,
        0,
      );
      assert.ok(
        await f.db.prepare("SELECT id FROM playlists WHERE id=?").get(p.id),
      );
    } finally {
      await f.close();
    }
  });
}
