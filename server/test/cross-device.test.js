import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, backends, password } from "./phase2-helpers.js";
import { redisInfrastructure } from "../infrastructure/redis.js";
import { migrate } from "../database/migrate.js";
const payload = (expectedRevision, positionSeconds, extra = {}) => ({
  expectedRevision,
  positionSeconds,
  clientId: randomUUID(),
  sequence: 1,
  ...extra,
});
for (const kind of backends) {
  const run = async (fn) => {
    const f = await fixture(kind);
    try {
      const a = await f.client(),
        b = await f.client(),
        email = randomUUID() + "@example.com";
      await a.auth("register", { email, password, displayName: "Listener" });
      await b.auth("login", { email, password });
      await fn(f, a, b);
    } finally {
      await f.close();
    }
  };
  test(`${kind}: cross-device CAS permits one simultaneous writer and rejects stale device state`, () =>
    run(async (f, a, b) => {
      assert.equal((await a.get("/progress/101")).body.progress.revision, 0);
      assert.equal((await b.get("/progress/101")).body.progress.revision, 0);
      const results = await Promise.all([
        a.write("put", "/progress/101", payload(0, 10)),
        b.write("put", "/progress/101", payload(0, 20)),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      const state = (await a.get("/progress/101")).body.progress;
      assert.equal(state.revision, 1);
      const loser = results.find((r) => r.status === 409);
      assert.equal(loser.body.error.code, "PROGRESS_CONFLICT");
      assert.deepEqual(loser.body.progress, state);
      const stale = await b
        .write("put", "/progress/101", payload(0, 1))
        .expect(409);
      assert.deepEqual(stale.body.progress, state);
    }));
  test(`${kind}: exact receipt retry is effect-free and identity payload reuse is rejected`, () =>
    run(async (f, a, b) => {
      const duration = (await a.get("/stories/1/chapters")).body.chapters[0]
          .duration_seconds,
        body = payload(0, duration, { completed: true });
      const first = await a.write("put", "/progress/101", body).expect(200),
        repeated = await b.write("put", "/progress/101", body).expect(200);
      assert.equal(first.body.acknowledgedRevision, 1);
      assert.equal(repeated.body.replayed, true);
      assert.equal(repeated.body.progress.revision, 1);
      for (const patch of [
        { positionSeconds: duration - 0.5 },
        { expectedRevision: 1 },
        { completed: false },
        { action: "reset", positionSeconds: 0, completed: false },
      ])
        assert.equal(
          (
            await a
              .write("put", "/progress/101", { ...body, ...patch })
              .expect(409)
          ).body.error.code,
          "PROGRESS_IDENTITY_REUSED",
        );
      const events = await f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM listening_events WHERE user_id=? AND event_type='chapter_completed'",
        )
        .get(a.data.user.id);
      assert.equal(events.n, 1);
    }));
  test(`${kind}: intentional rewind and explicit replay preserve completion transitions`, () =>
    run(async (f, a, b) => {
      await a.write("put", "/progress/101", payload(0, 20)).expect(200);
      await b.write("put", "/progress/101", payload(1, 5)).expect(200);
      assert.equal(
        (await a.get("/progress/101")).body.progress.position_seconds,
        5,
      );
      const duration = (await a.get("/stories/1/chapters")).body.chapters[0]
        .duration_seconds;
      await a
        .write(
          "put",
          "/progress/101",
          payload(2, duration, { completed: true }),
        )
        .expect(200);
      await b.write("put", "/progress/101", payload(1, 2)).expect(409);
      assert.equal(
        (await b.write("put", "/progress/101", payload(3, 2)).expect(409)).body
          .error.code,
        "PROGRESS_RESET_REQUIRED",
      );
      await b
        .write("put", "/progress/101", payload(3, 0, { action: "reset" }))
        .expect(200);
      const state = (await a.get("/progress/101")).body.progress;
      assert.equal(state.completed, false);
      assert.equal(state.revision, 4);
      assert.equal(
        (await a.get("/analytics/overview")).body.recentActivity.filter(
          (e) => e.event_type === "chapter_completed",
        ).length,
        1,
      );
    }));
  test(`${kind}: retired receipts cannot mutate state and duplicate acknowledgement exposes newer remote state`, () =>
    run(async (f, a, b) => {
      const body = payload(0, 10);
      await a.write("put", "/progress/101", body).expect(200);
      await b.write("put", "/progress/101", payload(1, 15)).expect(200);
      const retry = await a.write("put", "/progress/101", body).expect(200);
      assert.equal(retry.body.acknowledgedRevision, 1);
      assert.equal(retry.body.progress.revision, 2);
      await a
        .write("put", "/progress/101", {
          ...body,
          sequence: 2,
          expectedRevision: 2,
          positionSeconds: 8,
        })
        .expect(200);
      assert.equal(
        (await a.write("put", "/progress/101", body).expect(409)).body.error
          .code,
        "PROGRESS_WRITE_RETIRED",
      );
    }));
  test(`${kind}: progress revision protocol rejects legacy writers, forged ownership and invalid requests`, () =>
    run(async (f, a) => {
      await a.write("put", "/progress/101", { positionSeconds: 3 }).expect(428);
      for (const patch of [
        { expectedRevision: -1 },
        { expectedRevision: 1.5 },
        { sequence: 0 },
        { action: "magic" },
        { clientId: "forged" },
        { userId: randomUUID() },
        { action: "reset", completed: true, positionSeconds: 35 },
      ])
        await a
          .write("put", "/progress/101", { ...payload(0, 3), ...patch })
          .expect(400);
      const other = await f.client();
      await other.auth("demo");
      await other.write("put", "/progress/101", payload(0, 8)).expect(200);
      assert.equal((await a.get("/progress/101")).body.progress.revision, 0);
      await a.agent.put("/api/progress/101").send(payload(0, 3)).expect(403);
    }));
  test(`${kind}: progress receipt metadata is bounded and failed transactions roll back state/effects`, () =>
    run(async (f, a) => {
      const body = payload(0, 2);
      const { saveProgress } = await import("../repositories/listening.js");
      const chapter = await f.db
        .prepare("SELECT * FROM chapters WHERE id=101")
        .get();
      await assert.rejects(
        f.db.transaction(async () => {
          await saveProgress(f.db, a.data.user.id, chapter, {
            position: chapter.duration_seconds,
            isComplete: true,
            ...body,
          });
          throw Error("rollback");
        }),
        /rollback/,
      );
      assert.equal((await a.get("/progress/101")).body.progress.revision, 0);
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT COUNT(*) AS n FROM listening_events WHERE user_id=?",
            )
            .get(a.data.user.id)
        ).n,
        0,
      );
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT COUNT(*) AS n FROM background_jobs WHERE owner_id=? AND kind='analytics_rollup'",
            )
            .get(a.data.user.id)
        ).n,
        0,
      );
      for (let i = 0; i < 32; i++)
        await a.write("put", "/progress/101", payload(i, i + 1)).expect(200);
      const cap = await a
        .write("put", "/progress/101", payload(32, 3))
        .expect(429);
      assert.equal(cap.body.error.code, "PROGRESS_CLIENT_LIMIT");
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT COUNT(*) AS n FROM progress_write_versions WHERE user_id=?",
            )
            .get(a.data.user.id)
        ).n,
        32,
      );
    }));
  test(`${kind}: populated revision migration preserves progress, completion, events and old client high-water marks`, () =>
    run(async (f, a) => {
      const user = a.data.user.id;
      await f.db
        .prepare(
          "INSERT INTO listening_progress(user_id,chapter_id,position_seconds,completed) VALUES(?,101,35,1)",
        )
        .run(user);
      await f.db
        .prepare(
          "INSERT INTO progress_write_versions(user_id,chapter_id,client_id,sequence) VALUES(?,101,?,7)",
        )
        .run(user, randomUUID());
      // Rewind only this disposable fixture to the real M1.3 schema.
      await f.db
        .prepare("ALTER TABLE listening_progress DROP COLUMN revision")
        .run();
      for (const col of [
        "request_hash",
        "accepted_revision",
        "ack_position",
        "ack_completed",
        "ack_updated_at",
        "result_code",
      ])
        await f.db
          .prepare(`ALTER TABLE progress_write_versions DROP COLUMN ${col}`)
          .run();
      const version =
        kind === "postgres"
          ? "011_progress_revisions.sql"
          : "012_progress_revisions.sql";
      await f.db
        .prepare("DELETE FROM schema_migrations WHERE version IN(?,?)")
        .run(
          version,
          kind === "postgres"
            ? "012_progress_attempt_receipts.sql"
            : "013_progress_attempt_receipts.sql",
        );
      await migrate(f.db);
      await migrate(f.db);
      const s = (await a.get("/progress/101")).body.progress;
      assert.equal(s.revision, 0);
      assert.equal(s.completed, true);
      assert.equal(s.position_seconds, 35);
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT sequence FROM progress_write_versions WHERE user_id=?",
            )
            .get(user)
        ).sequence,
        7,
      );
    }));
  test(`${kind}: equivalent-state writes acknowledge without advancing revision or effects`, () =>
    run(async (f, a) => {
      await a.write("put", "/progress/101", payload(0, 10)).expect(200);
      const same = await a
        .write("put", "/progress/101", payload(1, 10))
        .expect(200);
      assert.equal(same.body.progress.revision, 1);
      assert.equal(same.body.acknowledgedRevision, 1);
    }));
  if (process.env.TEST_REDIS_URL)
    test(`${kind}: progress survives Redis disconnect/reconnect and streaming remains available`, async () => {
      const redis = redisInfrastructure(process.env.TEST_REDIS_URL, {
          prefix: "sync-" + randomUUID(),
        }),
        f = await fixture(kind, { redis });
      try {
        await redis.client.connect();
        const c = await f.client();
        await c.auth("demo");
        await c.write("put", "/progress/101", payload(0, 5)).expect(200);
        redis.client.destroy();
        await c.get("/progress/101").expect(503);
        await c.write("put", "/progress/101", payload(1, 8)).expect(503);
        await c.agent
          .get("/api/chapters/101/stream")
          .set("Range", "bytes=0-99")
          .expect(206);
        await redis.client.connect();
        assert.equal((await c.get("/progress/101")).body.progress.revision, 1);
        await c.write("put", "/progress/101", payload(0, 1)).expect(409);
        await c.write("put", "/progress/101", payload(1, 8)).expect(200);
        assert.equal((await c.get("/progress/101")).body.progress.revision, 2);
      } finally {
        await redis.close();
        await f.close();
      }
    });
  test(`${kind}: rejected valid attempts also reserve their identity and cannot be repurposed`, () =>
    run(async (f, a, b) => {
      await a.write("put", "/progress/101", payload(0, 10)).expect(200);
      const rejected = payload(0, 5);
      await b.write("put", "/progress/101", rejected).expect(409);
      assert.equal(
        (await b.write("put", "/progress/101", rejected).expect(409)).body.error
          .code,
        "PROGRESS_CONFLICT",
      );
      assert.equal(
        (
          await b
            .write("put", "/progress/101", {
              ...rejected,
              expectedRevision: 1,
              positionSeconds: 3,
            })
            .expect(409)
        ).body.error.code,
        "PROGRESS_IDENTITY_REUSED",
      );
      assert.equal((await a.get("/progress/101")).body.progress.revision, 1);
    }));
}
