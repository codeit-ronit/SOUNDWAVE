import { backfillRollups } from "../jobs/backfill.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { backends, fixture } from "./phase2-helpers.js";
import { jobQueue } from "../jobs/queue.js";
import { runOnce } from "../jobs/worker.js";
import { jobHandlers } from "../jobs/handlers.js";
import { recordEvent } from "../repositories/listening.js";
for (const kind of backends) {
  test(`${kind}: outbox writes commit/rollback with events and retries do not duplicate jobs`, async () => {
    const f = await fixture(kind);
    try {
      const id = randomUUID();
      await assert.rejects(
        f.db.transaction(async () => {
          await recordEvent(f.db, {
            user: "demo-user",
            id,
            type: "listening_interval",
            storyId: 1,
            chapterId: 101,
            listeningSeconds: 3,
          });
          throw Error("rollback");
        }),
      );
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM listening_events").get())
          .n,
        0,
      );
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM background_jobs").get())
          .n,
        0,
      );
      for (let n = 0; n < 2; n++)
        await recordEvent(f.db, {
          user: "demo-user",
          id,
          type: "listening_interval",
          storyId: 1,
          chapterId: 101,
          listeningSeconds: 3,
        });
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM background_jobs").get())
          .n,
        1,
      );
      await recordEvent(f.db, {
        user: "demo-user",
        type: "playback_paused",
        storyId: 1,
        chapterId: 101,
        listeningSeconds: 2,
      });
      while (await runOnce(f.db)) {}
      assert.equal(await backfillRollups(f.db), 1);
      assert.equal(await backfillRollups(f.db), 0);
      while (await runOnce(f.db)) {}
      const rollup = (
        await f.db.prepare("SELECT * FROM analytics_rollups").all()
      )[0];
      assert.equal(rollup.listening_seconds, 5);
      assert.equal(rollup.interval_count, 2);
      await jobQueue(f.db).enqueue("analytics_rollup", {
        owner: "demo-user",
        payload: { day: rollup.day },
      });
      await runOnce(f.db);
      assert.equal(
        (
          await f.db
            .prepare("SELECT listening_seconds FROM analytics_rollups")
            .get()
        ).listening_seconds,
        5,
      );
    } finally {
      await f.close();
    }
  });
  test(`${kind}: concurrent workers claim distinct jobs; stale leases cannot acknowledge another worker`, async () => {
    const f = await fixture(kind);
    try {
      const q = jobQueue(f.db);
      await q.enqueue("maintenance");
      await q.enqueue("maintenance");
      const [a, b] = await Promise.all([q.claim("a"), q.claim("b")]);
      assert.notEqual(a.id, b.id);
      await f.db
        .prepare("UPDATE background_jobs SET lease_until=? WHERE id=?")
        .run("2000-01-01T00:00:00.000Z", a.id);
      const replacement = await q.claim("c");
      assert.equal(replacement.id, a.id);
      assert.notEqual(replacement.locked_by, a.locked_by);
      let effects = 0;
      assert.equal(await q.perform(a, async () => effects++), false);
      assert.equal(effects, 0);
      assert.equal(await q.perform(replacement, async () => effects++), true);
      assert.equal(effects, 1);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: failed work rolls back, backs off and becomes an observable dead letter`, async () => {
    const f = await fixture(kind);
    try {
      const q = jobQueue(f.db),
        id = await q.enqueue("maintenance", { maxAttempts: 2 }),
        a = await q.claim("a");
      await assert.rejects(
        q.perform(a, async () => {
          await f.db
            .prepare("INSERT INTO favorites(user_id,story_id) VALUES(?,?)")
            .run("demo-user", 1);
          throw Error("fixture");
        }),
      );
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM favorites").get()).n,
        0,
      );
      await q.fail(a, "fixture_failure");
      assert.equal(await q.claim("early"), null);
      await f.db
        .prepare("UPDATE background_jobs SET available_at=? WHERE id=?")
        .run("2000-01-01T00:00:00.000Z", id);
      const b = await q.claim("b");
      await q.fail(b, "fixture_failure");
      const dead = await f.db
        .prepare(
          "SELECT status,last_error,attempts FROM background_jobs WHERE id=?",
        )
        .get(id);
      assert.deepEqual(dead, {
        status: "dead",
        last_error: "fixture_failure",
        attempts: 2,
      });
    } finally {
      await f.close();
    }
  });
  test(`${kind}: maintenance removes expired guests and their data but preserves live/registered users`, async () => {
    const f = await fixture(kind);
    try {
      const a = await f.client();
      await a.auth("demo");
      const id = a.data.user.id;
      await a.write("put", "/library/1").expect(200);
      await f.db
        .prepare("UPDATE users SET created_at=? WHERE id=?")
        .run("2000-01-01T00:00:00.000Z", id);
      await jobHandlers(f.db).maintenance();
      assert.ok(await f.db.prepare("SELECT id FROM users WHERE id=?").get(id));
      await f.db
        .prepare("UPDATE sessions SET expires_at=? WHERE user_id=?")
        .run("2000-01-01T00:00:00.000Z", id);
      await f.db.transaction(() => jobHandlers(f.db).maintenance());
      assert.equal(
        await f.db.prepare("SELECT id FROM users WHERE id=?").get(id),
        undefined,
      );
      assert.ok(
        await f.db.prepare("SELECT id FROM users WHERE id='demo-user'").get(),
      );
    } finally {
      await f.close();
    }
  });
}

if (process.env.TEST_DATABASE_URL)
  test("PostgreSQL connection loss during async transaction rolls back without an uncaught client error", async () => {
    const f = await fixture("postgres");
    try {
      await assert.rejects(
        f.db.transaction(async () => {
          await f.db
            .prepare("INSERT INTO favorites(user_id,story_id) VALUES(?,?)")
            .run("demo-user", 1);
          const { pid } = await f.db
            .prepare("SELECT pg_backend_pid() AS pid")
            .get();
          await f.db.pool.query("SELECT pg_terminate_backend($1)", [pid]);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }),
      );
      assert.equal(
        (await f.db.prepare("SELECT COUNT(*) AS n FROM favorites").get()).n,
        0,
      );
      assert.equal((await f.db.prepare("SELECT 1 AS alive").get()).alive, 1);
    } finally {
      await f.close();
    }
  });
