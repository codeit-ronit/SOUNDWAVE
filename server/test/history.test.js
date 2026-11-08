import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, backends } from "./phase2-helpers.js";
import { redisInfrastructure } from "../infrastructure/redis.js";
import { migrate } from "../database/migrate.js";
import { historyService } from "../services/history.js";
const body = (revision, position = 5, extra = {}) => ({
  expectedRevision: revision,
  positionSeconds: position,
  clientId: randomUUID(),
  sequence: 1,
  ...extra,
});
for (const kind of backends) {
  const run = async (fn) => {
    const f = await fixture(kind);
    try {
      const a = await f.client(),
        b = await f.client();
      await a.auth("demo");
      await b.auth("demo");
      await fn(f, a, b);
    } finally {
      await f.close();
    }
  };
  test(`${kind}: history pagination is bounded, owner-bound, precise and survives a deleted boundary`, () =>
    run(async (f, a, b) => {
      for (const id of [101, 102, 201, 202])
        await a.write("put", `/progress/${id}`, body(0)).expect(200);
      const stamp =
        kind === "postgres"
          ? "2026-11-08T10:00:00.000123Z"
          : "2026-11-08T10:00:00.123Z";
      await f.db
        .prepare("UPDATE listening_progress SET updated_at=? WHERE user_id=?")
        .run(stamp, a.data.user.id);
      let p = (await a.get("/history?limit=2").expect(200)).body;
      assert.deepEqual(
        p.entries.map((e) => e.chapter_id),
        [202, 201],
      );
      assert.ok(p.nextCursor);
      assert.equal(p.historyRevision, 4);
      await b.get("/history?limit=2&cursor=" + p.nextCursor).expect(400);
      await a
        .write("delete", "/history/201", { expectedRevision: 1 })
        .expect(200);
      p = (await a.get("/history?limit=2&cursor=" + p.nextCursor).expect(200))
        .body;
      assert.deepEqual(
        p.entries.map((e) => e.chapter_id),
        [102, 101],
      );
      assert.equal(p.nextCursor, null);
      if (kind === "postgres") {
        await f.db
          .prepare(
            "UPDATE listening_progress SET updated_at=? WHERE user_id=? AND chapter_id=202",
          )
          .run("2026-11-08T10:00:00.000222Z", a.data.user.id);
        const first = (await a.get("/history?limit=1")).body,
          second = (await a.get("/history?limit=1&cursor=" + first.nextCursor))
            .body;
        assert.equal(first.entries[0].chapter_id, 202);
        assert.equal(second.entries[0].chapter_id, 102);
      }
    }));
  test(`${kind}: history rejects malformed cursors, selectors, CSRF and anonymous reads/writes`, () =>
    run(async (f, a) => {
      const anon = await f.client();
      await anon.get("/history").expect(401);
      await anon
        .write("delete", "/history/101", { expectedRevision: 0 })
        .expect(401);
      for (const q of [
        "limit=0",
        "limit=51",
        "limit=1.5",
        "limit=01",
        "limit=1&limit=2",
        "ownerId=forged",
        "cursor=bad!",
        "cursor=" +
          Buffer.from(
            JSON.stringify({
              v: 1,
              owner: a.data.user.id,
              at: "2026-02-31T00:00:00.000Z",
              chapter: 101,
            }),
          ).toString("base64url"),
      ])
        await a.get("/history?" + q).expect(400);
      for (const p of ["bad", "0", "-1", "1%20OR%201=1"])
        await a
          .write("delete", "/history/" + p, { expectedRevision: 0 })
          .expect(400);
      for (const request of [
        {},
        { expectedRevision: -1 },
        { expectedRevision: 1, userId: "forged" },
      ])
        await a.write("delete", "/history/101", request).expect(400);
      await a.agent
        .delete("/api/history/101")
        .send({ expectedRevision: 0 })
        .expect(403);
      await a
        .write("delete", "/history", {
          expectedHistoryRevision: 0,
          confirm: "wrong",
        })
        .expect(400);
    }));
  test(`${kind}: removal is owned, idempotent and retains completion, events, favorites and playlists`, () =>
    run(async (f, a, b) => {
      const duration = (await a.get("/stories/1/chapters")).body.chapters[0]
        .duration_seconds;
      await a
        .write("put", "/progress/101", body(0, duration, { completed: true }))
        .expect(200);
      await a.write("put", "/progress/102", body(0, 8)).expect(200);
      await a.write("put", "/library/1").expect(200);
      const list = (await a.write("post", "/playlists", { name: "Kept" })).body
        .playlist;
      await a.write("put", `/playlists/${list.id}/stories/1`).expect(200);
      const analytics = (await a.get("/analytics/overview")).body;
      const foreign = await b
          .write("delete", "/history/101", { expectedRevision: 1 })
          .expect(200),
        missing = await b
          .write("delete", "/history/999999", { expectedRevision: 1 })
          .expect(200);
      assert.deepEqual(foreign.body, missing.body);
      const removed = (
        await a
          .write("delete", "/history/101", { expectedRevision: 1 })
          .expect(200)
      ).body;
      assert.equal(removed.progress.revision, 2);
      assert.equal(removed.progress.removed, true);
      assert.equal(removed.progress.completed, true);
      assert.deepEqual(
        (
          await a
            .write("delete", "/history/101", { expectedRevision: 1 })
            .expect(200)
        ).body,
        removed,
      );
      assert.deepEqual((await a.get("/analytics/overview")).body, analytics);
      assert.equal((await a.get("/library")).body.stories.length, 1);
      assert.equal(
        (await a.get(`/playlists/${list.id}`)).body.stories.length,
        1,
      );
      assert.deepEqual(
        (await a.get("/progress")).body.progress.map((p) => p.chapter_id),
        [102],
      );
      await a
        .write("delete", "/history/102", { expectedRevision: 1 })
        .expect(200);
      assert.equal((await a.get("/progress")).body.continueListening.length, 0);
      assert.equal(
        (await a.get("/progress/102")).body.progress.position_seconds,
        0,
      );
    }));
  test(`${kind}: tombstone revision blocks stale updates and prior receipts; explicit reset restores history`, () =>
    run(async (f, a) => {
      const original = body(0, 8);
      await a.write("put", "/progress/101", original).expect(200);
      await a
        .write("delete", "/history/101", { expectedRevision: 1 })
        .expect(200);
      const retry = await a.write("put", "/progress/101", original).expect(200);
      assert.equal(retry.body.replayed, true);
      assert.equal(retry.body.progress.removed, true);
      assert.equal(retry.body.progress.revision, 2);
      assert.equal(retry.body.acknowledgedRevision, 1);
      await a.write("put", "/progress/101", body(1, 9)).expect(409);
      assert.equal(
        (await a.write("put", "/progress/101", body(2, 9)).expect(409)).body
          .error.code,
        "PROGRESS_RESET_REQUIRED",
      );
      await a
        .write("put", "/progress/101", body(2, 3, { action: "reset" }))
        .expect(200);
      assert.equal(
        (await a.get("/history")).body.entries[0].position_seconds,
        3,
      );
      assert.equal((await a.get("/progress/101")).body.progress.revision, 3);
      await a
        .write("delete", "/history/101", { expectedRevision: 1 })
        .expect(409);
      assert.equal((await a.get("/history")).body.entries.length, 1);
    }));
  test(`${kind}: guarded bulk clear is atomic, repeat-safe and does not erase post-clear activity`, () =>
    run(async (f, a) => {
      for (const id of [101, 102, 201])
        await a.write("put", `/progress/${id}`, body(0)).expect(200);
      const before = (await a.get("/history")).body;
      await a.write("put", "/progress/101", body(1, 7)).expect(200);
      await a
        .write("delete", "/history", {
          expectedHistoryRevision: before.historyRevision,
          confirm: "CLEAR_SAVED_HISTORY",
        })
        .expect(409);
      const current = (await a.get("/history")).body,
        clear = {
          expectedHistoryRevision: current.historyRevision,
          confirm: "CLEAR_SAVED_HISTORY",
        };
      const result = (await a.write("delete", "/history", clear).expect(200))
        .body;
      assert.equal(result.removedCount, 3);
      assert.equal(result.historyRevision, current.historyRevision + 1);
      assert.equal(
        (await a.write("delete", "/history", clear).expect(200)).body
          .removedCount,
        0,
      );
      assert.equal((await a.get("/history")).body.entries.length, 0);
      await a
        .write("put", "/progress/101", body(3, 1, { action: "reset" }))
        .expect(200);
      await a.write("delete", "/history", clear).expect(409);
      assert.equal((await a.get("/history")).body.entries.length, 1);
    }));
  test(`${kind}: concurrent history removal and progress updates serialize without resurrection`, () =>
    run(async (f, a) => {
      await a.write("put", "/progress/101", body(0)).expect(200);
      const race = await Promise.all([
        a.write("delete", "/history/101", { expectedRevision: 1 }),
        a.write("put", "/progress/101", body(1, 9)),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
      const state = (await a.get("/progress/101")).body.progress;
      assert.equal(state.revision, 2);
      assert.equal(state.removed, race[0].status === 200);
      await a.write("put", "/progress/102", body(0, 8)).expect(200);
      const secondBefore = (await a.get("/progress/102")).body.progress;
      const guard = (await a.get("/history")).body.historyRevision;
      await assert.rejects(
        f.db.transaction(async () => {
          await historyService(f.db).clear(a.data.user.id, guard);
          throw Error("rollback");
        }),
        /rollback/,
      );
      assert.deepEqual((await a.get("/progress/101")).body.progress, state);
      assert.deepEqual(
        (await a.get("/progress/102")).body.progress,
        secondBefore,
      );
      assert.equal((await a.get("/history")).body.historyRevision, guard);
    }));
  test(`${kind}: additive history migration preserves bookmarks, completion and revision receipts`, () =>
    run(async (f, a) => {
      await a.write("put", "/progress/101", body(0, 8)).expect(200);
      const duration = (await a.get("/stories/1/chapters")).body.chapters[1]
        .duration_seconds;
      await a
        .write("put", "/progress/102", body(0, duration, { completed: true }))
        .expect(200);
      await f.db.prepare("DROP INDEX progress_history_idx").run();
      await f.db
        .prepare("ALTER TABLE listening_progress DROP COLUMN history_removed")
        .run();
      await f.db
        .prepare("ALTER TABLE users DROP COLUMN history_revision")
        .run();
      const file = kind === "postgres" ? "013_history.sql" : "014_history.sql";
      await f.db
        .prepare("DELETE FROM schema_migrations WHERE version=?")
        .run(file);
      await migrate(f.db);
      await migrate(f.db);
      const page = (await a.get("/history")).body;
      assert.equal(
        page.entries.find((e) => e.chapter_id === 101).position_seconds,
        8,
      );
      assert.equal(page.entries.find((e) => e.chapter_id === 101).revision, 1);
      assert.equal(
        page.entries.find((e) => e.chapter_id === 102).completed,
        true,
      );
      assert.equal(page.historyRevision, 0);
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT sequence FROM progress_write_versions WHERE user_id=?",
            )
            .get(a.data.user.id)
        ).sequence,
        1,
      );
    }));
  test(`${kind}: history defaults to 20 and never exceeds the maximum 50-entry page`, () =>
    run(async (f, a) => {
      for (let n = 0; n < 60; n++) {
        await f.db
          .prepare(
            "INSERT INTO chapters(id,story_id,chapter_number,title,audio_url,duration_seconds) VALUES(?,1,?,?,'/audio/1-1.wav',35)",
          )
          .run(800000 + n, 100 + n, `Fixture ${n}`);
        await f.db
          .prepare(
            "INSERT INTO listening_progress(user_id,chapter_id,position_seconds,revision) VALUES(?,?,5,1)",
          )
          .run(a.data.user.id, 800000 + n);
      }
      assert.equal((await a.get("/history")).body.entries.length, 20);
      const first = (await a.get("/history?limit=50")).body,
        next = (await a.get("/history?limit=50&cursor=" + first.nextCursor))
          .body;
      assert.equal(first.entries.length, 50);
      assert.equal(next.entries.length, 10);
      assert.equal(
        new Set([...first.entries, ...next.entries].map((e) => e.chapter_id))
          .size,
        60,
      );
    }));
  test(`${kind}: concurrent guarded bulk clear and update cannot silently erase new activity`, () =>
    run(async (f, a) => {
      await a.write("put", "/progress/101", body(0)).expect(200);
      const results = await Promise.all([
        a.write("delete", "/history", {
          expectedHistoryRevision: 1,
          confirm: "CLEAR_SAVED_HISTORY",
        }),
        a.write("put", "/progress/101", body(1, 9)),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      const progress = (await a.get("/progress/101")).body.progress;
      assert.equal(progress.revision, 2);
      assert.equal(progress.removed, results[0].status === 200);
    }));
  if (process.env.TEST_REDIS_URL)
    test(`${kind}: private history bypasses shared catalog caching and fails safely during Redis outage`, async () => {
      const redis = redisInfrastructure(process.env.TEST_REDIS_URL, {
          prefix: "history-" + randomUUID(),
        }),
        f = await fixture(kind, {
          redis,
          config: { catalogCacheEnabled: true },
        });
      try {
        await redis.client.connect();
        const c = await f.client();
        await c.auth("demo");
        await c.get("/stories").expect(200);
        await c.write("put", "/progress/101", body(0)).expect(200);
        const before = redis.cacheStats();
        await c.get("/history?limit=1").expect(200);
        await c
          .write("delete", "/history/101", { expectedRevision: 1 })
          .expect(200);
        assert.deepEqual(redis.cacheStats(), before);
        redis.client.destroy();
        await c.get("/history").expect(503);
        await c
          .write("delete", "/history", {
            expectedHistoryRevision: 2,
            confirm: "CLEAR_SAVED_HISTORY",
          })
          .expect(503);
        await c.agent
          .get("/api/chapters/101/stream")
          .set("Range", "bytes=0-99")
          .expect(206);
        await redis.client.connect();
        assert.equal(
          (await c.get("/progress/101")).body.progress.removed,
          true,
        );
      } finally {
        await redis.close();
        await f.close();
      }
    });
}
