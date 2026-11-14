import { redisInfrastructure } from "../infrastructure/redis.js";
import { publicationFixture } from "./publishing-helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, reserve } from "./private-media-helpers.js";
import { backends, password } from "./phase2-helpers.js";
import { wav } from "./private-wav-fixture.js";
import { processPrivateMedia } from "../media/private-processor.js";
import { provisionIdentity } from "../services/creator-operator.js";
import { publicationService, RIGHTS_TERMS } from "../services/publications.js";
import { catalogRepository } from "../repositories/catalog.js";
for (const kind of backends) {
  test(`${kind}: publishing real MP3 requires exact review and revocation gates every public read`, async () => {
    const f = await publicationFixture(kind);
    let redis;
    try {
      if (process.env.TEST_REDIS_URL) {
        redis = redisInfrastructure(process.env.TEST_REDIS_URL, {
          prefix: "test:publication:" + randomUUID(),
        });
        await redis.client.connect();
        assert.ok(
          !(await catalogRepository(f.db, redis).stories(null)).some(
            (s) => s.id === f.s.id,
          ),
        );
      }
      const listener = await f.client();
      await listener.auth("demo");
      await listener.get(`/stories/${f.s.id}`).expect(404);
      await f
        .submit()
        .then((r) => assert.equal(r.body.publication.state, "submitted"));
      await f.c.get(`/stories/${f.s.id}`).expect(404);
      const review = (await f.moderator.get(f.review).expect(200)).body;
      assert.equal(review.current, true);
      assert.equal(review.chapters.length, 1);
      const path = `${f.review}/outputs/${review.chapters[0].outputId}/stream`;
      await f.moderator.get(path).set("Range", "bytes=0-11").expect(206);
      await listener.get(path).expect(403);
      await f.moderator.get(`${f.path}/${f.a.id}/preview`).expect(403);
      await f.c
        .write("put", `/creator/stories/${f.s.id}`, {
          title: "Changed",
          description: "",
          genre: "Test",
          language: "en",
          expectedRevision: f.s.revision,
        })
        .expect(409);
      await f
        .approve()
        .then((r) => assert.equal(r.body.publication.state, "approved"));
      await listener.get(`/chapters/${f.ch.id}/stream`).expect(404);
      await f
        .publish()
        .then((r) => assert.equal(r.body.publication.state, "published"));
      const pub = (await listener.get(`/stories/${f.s.id}`).expect(200)).body
        .story;
      assert.equal(pub.content_source, "creator");
      assert.ok(pub.duration_seconds > 1.9 && pub.duration_seconds < 2.2);
      for (const key of [
        "owner_id",
        "ownership_kind",
        "object_key",
        "snapshot_hash",
      ])
        assert.equal(Object.hasOwn(pub, key), false);
      const chapters = (
        await listener.get(`/stories/${f.s.id}/chapters`).expect(200)
      ).body.chapters;
      assert.equal(chapters.length, 1);
      assert.ok(chapters[0].audio_bytes > 0);
      const stream = `/chapters/${f.ch.id}/stream`;
      await listener
        .get(stream)
        .expect(200)
        .expect("Content-Type", /audio\/mpeg/)
        .expect("Cache-Control", "no-store");
      await listener.agent
        .head(`/api${stream}`)
        .set("Range", "bytes=bad")
        .expect(200);
      await listener
        .get(stream)
        .set("Range", "bytes=0-11")
        .expect(206)
        .expect("Content-Length", "12");
      await listener.get(stream).set("Range", "bytes=999999-").expect(416);
      await listener.write("put", `/library/${f.s.id}`).expect(200);
      const playlist = (
        await listener
          .write("post", "/playlists", { name: "Creator list" })
          .expect(201)
      ).body.playlist;
      await listener
        .write("put", `/playlists/${playlist.id}/stories/${f.s.id}`)
        .expect(200);
      await listener
        .write("post", "/analytics/events", {
          id: randomUUID(),
          type: "playback_started",
          chapterId: f.ch.id,
        })
        .expect(201);
      const cacheRows = await catalogRepository(f.db).stories(null);
      const publishedRevision = (
        await f.db
          .prepare("SELECT revision FROM catalog_revision WHERE id=1")
          .get()
      ).revision;
      if (redis) {
        assert.ok(
          (await catalogRepository(f.db, redis).stories(null)).some(
            (s) => s.id === f.s.id,
          ),
        );
      }

      const stale = {
        cached: async (_revision, key, fn) =>
          key.includes("stories") ? cacheRows : fn(),
      };
      // Force actual Redis to return the old published revision, emulating a stale cache/reader.
      const cached = catalogRepository(
        f.db,
        redis
          ? {
              cached: (_revision, key, load) =>
                redis.cached(publishedRevision, key, load),
            }
          : stale,
      );
      assert.ok((await cached.stories(null)).some((s) => s.id === f.s.id));
      await f
        .action(f.moderator, f.review, "revoke", {
          code: "rights_concern",
          note: "Rights review required.",
        })
        .then((r) => assert.equal(r.body.publication.state, "revoked"));
      assert.ok(!(await cached.stories(null)).some((s) => s.id === f.s.id));
      assert.notEqual(
        (
          await f.db
            .prepare("SELECT revision FROM catalog_revision WHERE id=1")
            .get()
        ).revision,
        publishedRevision,
      );
      if (redis) {
        assert.ok(redis.cacheStats().hits > 0);
        assert.ok(
          !(await catalogRepository(f.db, redis).stories(null)).some(
            (s) => s.id === f.s.id,
          ),
        );
      }
      await listener.get(`/stories/${f.s.id}`).expect(404);
      await listener.get(stream).set("Range", "bytes=0-2").expect(404);
      await listener.agent.head(`/api${stream}`).expect(404);
      assert.equal(
        (await listener.get(`/playlists/${playlist.id}`)).body.stories.length,
        0,
      );
      assert.ok(
        (
          await f.db
            .prepare(
              "SELECT COUNT(*) AS n FROM listening_events WHERE story_id=?",
            )
            .get(f.s.id)
        ).n > 0,
      );
      await f.publish().then((r) => assert.equal(r.status, 409));
    } finally {
      if (redis) {
        let cursor = "0";
        do {
          const page = await redis.client.scan(cursor, {
            MATCH: redis.prefix + ":*",
            COUNT: 100,
          });
          cursor = String(page.cursor);
          if (page.keys.length) await redis.client.del(page.keys);
        } while (cursor !== "0");
        await redis.close();
      }
      await f.close();
    }
  });
  test(`${kind}: publication role checks, rights validation, receipts and concurrent decisions serialize`, async () => {
    const f = await publicationFixture(kind);
    try {
      const guest = await f.client();
      await guest.get(f.review).expect(401);
      await f.c
        .write(
          "post",
          f.base + "/submit",
          f.body(0, { attest: true, termsVersion: "forged" }),
        )
        .expect(400);
      await f.c
        .write("post", f.base + "/submit", {
          ...f.body(0, { attest: true, termsVersion: RIGHTS_TERMS }),
          ownerId: f.moderator.data.user.id,
        })
        .expect(400);
      const b = f.body(0, { attest: true, termsVersion: RIGHTS_TERMS });
      await f.c.write("post", f.base + "/submit", b).expect(200);
      const again = await f.c.write("post", f.base + "/submit", b).expect(200);
      assert.equal(again.body.replayed, true);
      const r = again.body.publication.revision;
      await f.c
        .write(
          "post",
          f.review + "/approve",
          f.body(r, { code: "approved", note: "Forged role" }),
        )
        .expect(403);
      await f.moderator
        .write(
          "post",
          f.review + "/approve",
          f.body(r, { code: "approved", note: "" }),
        )
        .expect(400);
      const responses = await Promise.all(
        ["approve", "reject"].map((action) =>
          f.moderator.write(
            "post",
            f.review + "/" + action,
            f.body(r, {
              code: action === "approve" ? "approved" : "metadata_issue",
              note: "Concurrent review",
            }),
          ),
        ),
      );
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT COUNT(*) AS n FROM publication_audit WHERE story_id=?",
            )
            .get(f.s.id)
        ).n,
        2,
      );
      // Same receipt cannot be repurposed, and a stale decision cannot mutate state.
      await f.c
        .write("post", f.base + "/submit", { ...b, termsVersion: "changed" })
        .expect(409);
      await f.c.write("post", f.base + "/publish", f.body(r)).expect(409);
      const data = (await f.c.get(f.base)).body;
      assert.equal(
        data.audit.find((a) => a.action === "submit").termsVersion,
        RIGHTS_TERMS,
      );
      await provisionIdentity(f.db, "role", f.c.data.user.id, "admin");
      await f.c
        .write(
          "post",
          f.review + "/revoke",
          f.body(data.publication.revision, {
            code: "rights_concern",
            note: "Self review",
          }),
        )
        .expect(403);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: changed media, content edits and creator suspension never preserve approval`, async () => {
    const f = await publicationFixture(kind);
    try {
      await f.submit();
      await f.approve();
      await f.publish();
      await f
        .action(f.c, f.base, "unpublish")
        .then((r) => assert.equal(r.status, 200));
      await f.c
        .write("put", `/creator/stories/${f.s.id}/chapters/${f.ch.id}`, {
          title: "Revised chapter",
          summary: "",
          expectedRevision: f.ch.revision,
        })
        .expect(200);
      await f.publish().then((r) => assert.equal(r.status, 409));
      await f.submit().then((r) => assert.equal(r.status, 200));
      await f.approve();
      await f.publish();
      await provisionIdentity(f.db, "status", f.c.data.user.id, "suspended");
      await f.moderator.get(f.review).expect(200);
      assert.equal(
        (await f.moderator.get(f.review)).body.publication.state,
        "revoked",
      );
      await f.moderator.get(`/chapters/${f.ch.id}/stream`).expect(404);
      await provisionIdentity(f.db, "status", f.c.data.user.id, "active");
      await f.c.get(`/chapters/${f.ch.id}/stream`).expect(404);
      await f.publish().then((r) => assert.equal(r.status, 409));
      await f.submit();
      const p = (await f.c.get(f.base)).body.publication;
      await f.db
        .prepare(
          "UPDATE private_media_outputs SET checksum=? WHERE id=(SELECT output_id FROM publication_chapters WHERE story_id=?)",
        )
        .run("0".repeat(64), f.s.id);
      await f.moderator
        .write(
          "post",
          f.review + "/approve",
          f.body(p.revision, { code: "approved", note: "Stale output" }),
        )
        .expect(409);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: publication transaction rollback and publish versus revoke races are safe`, async () => {
    const f = await publicationFixture(kind);
    try {
      await f.submit();
      await f.approve();
      const p = (await f.c.get(f.base)).body.publication;
      const svc = publicationService(f.db, f.config),
        original = f.db.prepare;
      f.db.prepare = (sql) =>
        sql.startsWith("INSERT INTO publication_audit")
          ? {
              run: async () => {
                throw Error("audit unavailable");
              },
            }
          : original(sql);
      await assert.rejects(
        svc.transition(
          { id: f.c.data.user.id },
          f.s.id,
          "publish",
          f.body(p.revision),
        ),
        /audit unavailable/,
      );
      f.db.prepare = original;
      assert.equal((await f.c.get(f.base)).body.publication.state, "approved");
      await f.c.get(`/chapters/${f.ch.id}/stream`).expect(404);
      const responses = await Promise.all([
        f.c.write("post", f.base + "/publish", f.body(p.revision)),
        f.moderator.write(
          "post",
          f.review + "/revoke",
          f.body(p.revision, {
            code: "content_policy",
            note: "Revocation race",
          }),
        ),
      ]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      if (
        (await f.moderator.get(f.review)).body.publication.state === "published"
      )
        await f.action(f.moderator, f.review, "revoke", {
          code: "content_policy",
          note: "Final revoke",
        });
      await f.c.get(`/chapters/${f.ch.id}/stream`).expect(404);
    } finally {
      await f.close();
    }
  });
}
for (const kind of backends) {
  test(`${kind}: additive publishing migration preserves processed media without granting visibility`, async () => {
    const f = await publicationFixture(kind);
    try {
      const migration =
        kind === "postgres" ? "018_publishing.sql" : "019_publishing.sql";
      for (const table of [
        "publication_receipts",
        "publication_audit",
        "publication_chapters",
        "story_publications",
      ])
        await f.db.prepare(`DROP TABLE ${table}`).run();
      await f.db
        .prepare("DELETE FROM schema_migrations WHERE version=?")
        .run(migration);
      if (kind === "postgres") {
        const { migrate } = await import("../database/migrate.js");
        await migrate(f.db);
      } else {
        const { readFileSync } = await import("node:fs"),
          { createHash } = await import("node:crypto");
        const sql = readFileSync(
          new URL("../migrations/sqlite/" + migration, import.meta.url),
          "utf8",
        );
        await f.db.transaction(async () => {
          f.db.raw.exec(sql);
          await f.db
            .prepare(
              "INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)",
            )
            .run(
              migration,
              createHash("sha256").update(sql).digest("hex"),
              new Date().toISOString(),
            );
        });
      }
      assert.equal(
        (await f.c.get(f.path)).body.processingIntent.status,
        "ready",
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT COUNT(*) AS n FROM story_publications")
            .get()
        ).n,
        0,
      );
      await f.c.get(`/chapters/${f.ch.id}/stream`).expect(404);
      await f.submit().then((r) => assert.equal(r.status, 200));
    } finally {
      await f.close();
    }
  });
  test(`${kind}: admin suspension revokes all active publications and preserves audit attribution`, async () => {
    const f = await publicationFixture(kind);
    try {
      await f.submit();
      await f.approve();
      await f.publish();
      await f
        .action(f.moderator, f.review, "suspend", {
          code: "content_policy",
          note: "Policy breach",
        })
        .then((r) => assert.equal(r.status, 403));
      await provisionIdentity(f.db, "role", f.moderator.data.user.id, "admin");
      await f
        .action(f.moderator, f.review, "suspend", {
          code: "content_policy",
          note: "Policy breach",
        })
        .then((r) => assert.equal(r.status, 200));
      const d = (await f.moderator.get(f.review)).body;
      assert.equal(d.publication.state, "revoked");
      assert.equal(d.audit[0].actorId, f.moderator.data.user.id);
      assert.equal(d.audit[0].actorKind, "account");
      await f.moderator.get(`/chapters/${f.ch.id}/stream`).expect(404);
      await provisionIdentity(f.db, "status", f.c.data.user.id, "active");
      await f.c.get(`/chapters/${f.ch.id}/stream`).expect(404);
    } finally {
      await f.close();
    }
  });
}
for (const kind of backends) {
  test(`${kind}: private publication selectors, stale workers and uncertain receipts cannot restore revoked content`, async () => {
    const f = await publicationFixture(kind);
    try {
      const other = await f.client();
      await other.auth("register", {
        email: `${randomUUID()}@example.com`,
        password,
        displayName: "Other creator",
      });
      await other
        .write("post", "/creator", { displayName: "Other creator", bio: "" })
        .expect(200);
      await other.get(f.base).expect(404);
      await other
        .write(
          "post",
          f.base + "/submit",
          f.body(0, { attest: true, termsVersion: RIGHTS_TERMS }),
        )
        .expect(404);
      await f.moderator
        .get("/moderation/submissions?ownerId=" + f.c.data.user.id)
        .expect(400);
      await f.submit();
      await f.approve();
      const p = (await f.c.get(f.base)).body.publication,
        b = f.body(p.revision);
      await f.c.write("post", f.base + "/publish", b).expect(200);
      await f.action(f.moderator, f.review, "revoke", {
        code: "content_policy",
        note: "Explicit removal",
      });
      const replay = await f.c
        .write("post", f.base + "/publish", b)
        .expect(200);
      assert.equal(replay.body.publication.state, "revoked");
      assert.equal(replay.body.replayed, true);
      const intent = await f.db
        .prepare("SELECT id FROM private_processing_intents WHERE asset_id=?")
        .get(f.a.id);
      assert.equal(
        (await processPrivateMedia(f.db, f.config, intent.id)).unchanged,
        true,
      );
      await f.c.get(`/chapters/${f.ch.id}/stream`).expect(404);
      await f.submit();
      await f.db
        .prepare(
          "UPDATE chapters SET draft_removed=1,draft_revision=draft_revision+1 WHERE id=?",
        )
        .run(f.ch.id);
      await f.approve().then((r) => assert.equal(r.status, 409));
      await f.moderator
        .get(`${f.review}/outputs/${randomUUID()}/stream`)
        .expect(404);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: publication refuses missing or corrupt actual derivative bytes and preserves review state`, async () => {
    const f = await publicationFixture(kind);
    try {
      const { writeFile } = await import("node:fs/promises"),
        { join } = await import("node:path");
      const out = await f.db
        .prepare(
          "SELECT * FROM private_media_outputs WHERE intent_id=(SELECT id FROM private_processing_intents WHERE asset_id=?)",
        )
        .get(f.a.id);
      await f.submit();
      await f.approve();
      await writeFile(
        join(f.config.privateMediaRoot, out.object_key + ".blob"),
        Buffer.alloc(out.byte_size, 0),
      );
      await f.publish().then((r) => assert.equal(r.status, 409));
      assert.equal((await f.c.get(f.base)).body.publication.state, "approved");
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT COUNT(*) AS n FROM publication_audit WHERE story_id=?",
            )
            .get(f.s.id)
        ).n,
        2,
      );
      await f.c.get(`/stories/${f.s.id}`).expect(404);
    } finally {
      await f.close();
    }
  });
}
