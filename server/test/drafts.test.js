import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, backends, password } from "./phase2-helpers.js";
import { draftService } from "../services/drafts.js";
import { provisionIdentity } from "../services/creator-operator.js";
import { seedCatalog } from "../database/seed.js";
import { migrate } from "../database/migrate.js";
const meta = {
  title: "Private story",
  description: "Private description",
  genre: "Private Genre",
  language: "en",
};
async function creator(f) {
  const c = await f.client();
  await c.auth("demo");
  await c.auth("register", {
    email: `${randomUUID()}@example.com`,
    password,
    displayName: "Draft owner",
  });
  await c
    .write("post", "/creator", { displayName: "Creator", bio: "" })
    .expect(200);
  return c;
}
const create = (c, extra = {}) =>
  c.write("post", "/creator/stories", {
    ...meta,
    requestId: randomUUID(),
    ...extra,
  });
function chapter(c, story, title = "Chapter", extra = {}) {
  return c.write("post", `/creator/stories/${story.id}/chapters`, {
    title,
    summary: "Private summary",
    requestId: randomUUID(),
    expectedStoryRevision: story.revision,
    ...extra,
  });
}
for (const kind of backends) {
  const run = async (fn) => {
    const f = await fixture(kind);
    try {
      await fn(f);
    } finally {
      await f.close();
    }
  };
  test(`${kind}: draft CRUD preserves IDs, archive state and durable creation retry identities`, () =>
    run(async (f) => {
      const a = await creator(f),
        body = { ...meta, requestId: randomUUID() },
        first = (await a.write("post", "/creator/stories", body).expect(201))
          .body;
      assert.equal(first.story.id, 900000000);
      assert.equal(first.story.revision, 1);
      assert.equal(first.story.state, "draft");
      const duplicate = (
        await a.write("post", "/creator/stories", body).expect(200)
      ).body;
      assert.equal(duplicate.replayed, true);
      assert.equal(duplicate.story.id, first.story.id);
      await a
        .write("post", "/creator/stories", {
          ...body,
          title: "Changed identity",
        })
        .expect(409);
      const base = `/creator/stories/${first.story.id}`;
      const edited = (
        await a
          .write("put", base, { ...meta, title: "Edited", expectedRevision: 1 })
          .expect(200)
      ).body;
      assert.equal(edited.story.revision, 2);
      const added = (await chapter(a, edited.story)).body;
      assert.equal(added.story.revision, 3);
      assert.equal(added.chapter.id, 900000000);
      assert.equal(added.chapter.position, 1);
      assert.equal(Object.hasOwn(added.chapter, "audio_url"), false);
      const archived = (
        await a
          .write("post", base + "/archive", { expectedRevision: 3 })
          .expect(200)
      ).body;
      assert.equal(archived.story.state, "archived");
      assert.equal(archived.story.revision, 4);
      const retried = (
        await a.write("post", "/creator/stories", body).expect(200)
      ).body;
      assert.equal(retried.story.state, "archived");
      assert.equal(retried.story.id, first.story.id);
      await a.write("put", base, { ...meta, expectedRevision: 4 }).expect(409);
      await a
        .write("post", base + "/archive", { expectedRevision: 3 })
        .expect(409);
      assert.equal((await create(a).expect(201)).body.story.id, 900000001);
      assert.equal(
        (
          await f.db
            .prepare("SELECT COUNT(*) AS n FROM stories WHERE id=?")
            .get(first.story.id)
        ).n,
        1,
      );
    }));
  test(`${kind}: private draft pagination is bounded, stable and owner-bound`, () =>
    run(async (f) => {
      const a = await creator(f),
        b = await creator(f);
      for (let i = 0; i < 22; i++)
        await create(a, { title: `Story ${i}` }).expect(201);
      const first = (await a.get("/creator/stories").expect(200)).body;
      assert.equal(first.stories.length, 20);
      assert.equal(first.stories[0].id, 900000021);
      await a
        .write("post", `/creator/stories/${first.stories.at(-1).id}/archive`, {
          expectedRevision: 1,
        })
        .expect(200);
      const rest = (
        await a.get("/creator/stories?cursor=" + first.nextCursor).expect(200)
      ).body;
      assert.equal(rest.stories.length, 2);
      assert.equal(rest.nextCursor, null);
      await b.get("/creator/stories?cursor=" + first.nextCursor).expect(400);
      assert.deepEqual((await b.get("/creator/stories")).body.stories, []);
      for (const q of [
        "limit=0",
        "limit=51",
        "limit=01",
        "limit=1&limit=2",
        "cursor=bad!",
        "ownerId=other",
      ])
        await a.get("/creator/stories?" + q).expect(400);
      assert.equal(
        (await a.get("/creator/stories?limit=50")).body.stories.length,
        22,
      );
    }));
  test(`${kind}: draft validation rejects forged fields, IDs, missing preconditions and unsafe metadata`, () =>
    run(async (f) => {
      const a = await creator(f),
        story = (await create(a)).body.story,
        base = `/creator/stories/${story.id}`;
      for (const patch of [
        { ownerId: randomUUID() },
        { role: "admin" },
        { ownership_kind: "system" },
        { draft_state: "published" },
        { audio_url: "https://evil.test/file" },
        { id: 123 },
        { title: " " },
        { title: "a".repeat(161) },
        { description: "a".repeat(3001) },
        { genre: "a".repeat(61) },
        { language: "../../en" },
        { title: "bad\u0000" },
        { requestId: "not-a-uuid" },
      ])
        await create(a, patch).expect(400);
      await a.write("put", base, meta).expect(428);
      for (const rev of [0, -1, "1", Number.MAX_SAFE_INTEGER + 1])
        await a
          .write("put", base, { ...meta, expectedRevision: rev })
          .expect(400);
      await a.agent
        .post("/api/creator/stories")
        .send({ ...meta, requestId: randomUUID() })
        .expect(403);
      for (const id of ["0", "bad", "1%20OR%201=1", "1000000000"])
        await a.get("/creator/stories/" + id).expect(400);
      await a.get(base + "?owner=other").expect(400);
      await a
        .write("post", base + "/chapters", {
          title: "No URL",
          summary: "",
          requestId: randomUUID(),
          expectedStoryRevision: 1,
          audioUrl: "/audio/1-1.wav",
        })
        .expect(400);
      await a
        .write("post", base + "/chapters", {
          title: "No duration",
          summary: "",
          requestId: randomUUID(),
          expectedStoryRevision: 1,
          durationSeconds: 5,
        })
        .expect(400);
    }));
  test(`${kind}: draft role and ownership checks deny guests, suspended creators and staff bypasses`, () =>
    run(async (f) => {
      const anon = await f.client();
      await anon.get("/creator/stories").expect(401);
      await anon.auth("demo");
      await anon.get("/creator/stories").expect(403);
      await create(anon).expect(403);
      const a = await creator(f),
        b = await creator(f),
        story = (await create(a)).body.story,
        base = `/creator/stories/${story.id}`;
      await provisionIdentity(f.db, "role", b.data.user.id, "admin");
      const missing = (await b.get("/creator/stories/999999999").expect(404))
        .body;
      assert.deepEqual((await b.get(base).expect(404)).body, missing);
      await b.write("put", base, { ...meta, expectedRevision: 1 }).expect(404);
      await b
        .write("post", base + "/archive", { expectedRevision: 1 })
        .expect(404);
      await b.get("/creator/stories/1").expect(404);
      await a.agent
        .get("/api" + base)
        .set("X-Session-User", b.data.user.id)
        .expect(409);
      for (const status of ["inactive", "suspended"]) {
        await provisionIdentity(f.db, "status", a.data.user.id, status);
        await a.get(base).expect(403);
        await a
          .write("put", base, { ...meta, expectedRevision: 1 })
          .expect(403);
        await create(a).expect(403);
      }
    }));
  test(`${kind}: same-resource draft edits conflict while independent resources retain both accepted edits`, () =>
    run(async (f) => {
      const a = await creator(f),
        first = (await create(a)).body.story,
        base = `/creator/stories/${first.id}`;
      const race = await Promise.all([
        a.write("put", base, {
          ...meta,
          title: "Winner A",
          expectedRevision: 1,
        }),
        a.write("put", base, {
          ...meta,
          title: "Winner B",
          expectedRevision: 1,
        }),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
      const current = (await a.get(base)).body;
      assert.equal(current.story.revision, 2);
      assert.equal(
        race.find((r) => r.status === 409).body.current.story.title,
        current.story.title,
      );
      const second = (await create(a)).body.story;
      const independent = await Promise.all([
        a.write("put", base, { ...meta, expectedRevision: 2 }),
        a.write("put", `/creator/stories/${second.id}`, {
          ...meta,
          expectedRevision: 1,
        }),
      ]);
      assert.deepEqual(
        independent.map((r) => r.status),
        [200, 200],
      );
      let data = (await chapter(a, independent[0].body.story, "One")).body;
      data = (await chapter(a, data.story, "Two")).body;
      const edits = await Promise.all(
        data.chapters.map((c) =>
          a.write("put", base + "/chapters/" + c.id, {
            title: c.title + " edited",
            summary: "New",
            expectedRevision: c.revision,
          }),
        ),
      );
      assert.deepEqual(
        edits.map((r) => r.status),
        [200, 200],
      );
      const both = (await a.get(base)).body;
      assert.equal(both.story.revision, data.story.revision);
      assert.ok(both.chapters.every((c) => c.title.endsWith(" edited")));
    }));
  test(`${kind}: chapter creation receipts survive later edits, removal and archived parents without duplicating`, () =>
    run(async (f) => {
      const a = await creator(f),
        story = (await create(a)).body.story,
        base = `/creator/stories/${story.id}`,
        body = {
          title: "Created once",
          summary: "",
          requestId: randomUUID(),
          expectedStoryRevision: 1,
        };
      const added = (
        await a.write("post", base + "/chapters", body).expect(201)
      ).body;
      await a
        .write("put", base + "/chapters/" + added.chapter.id, {
          title: "Edited once",
          summary: "",
          expectedRevision: 1,
        })
        .expect(200);
      const retry = (
        await a.write("post", base + "/chapters", body).expect(200)
      ).body;
      assert.equal(retry.chapter.title, "Edited once");
      assert.equal(retry.chapters.length, 1);
      await a
        .write("post", base + "/chapters", { ...body, title: "Reused request" })
        .expect(409);
      const removed = (
        await a
          .write("delete", base + "/chapters/" + added.chapter.id, {
            expectedRevision: 2,
            expectedStoryRevision: 2,
          })
          .expect(200)
      ).body;
      assert.equal(removed.chapter.removed, true);
      assert.equal(removed.chapters.length, 0);
      assert.equal(
        (await a.write("post", base + "/chapters", body).expect(200)).body
          .chapter.removed,
        true,
      );
      await a
        .write("put", base + "/chapters/" + added.chapter.id, {
          title: "Cannot restore",
          summary: "",
          expectedRevision: 3,
        })
        .expect(409);
      await a
        .write("post", base + "/archive", { expectedRevision: 3 })
        .expect(200);
      const after = (
        await a.write("post", base + "/chapters", body).expect(200)
      ).body;
      assert.equal(after.story.state, "archived");
      assert.equal(after.chapters.length, 0);
    }));
  test(`${kind}: chapter reorder/removal uses atomic unique positions and monotonic resource revisions`, () =>
    run(async (f) => {
      const a = await creator(f);
      let data = (await create(a)).body;
      for (const title of ["One", "Two", "Three"])
        data = (await chapter(a, data.story, title)).body;
      const base = `/creator/stories/${data.story.id}`,
        old = data.chapters,
        reverse = old.map((c) => c.id).reverse();
      const reordered = (
        await a
          .write("put", base + "/chapters/order", {
            chapterIds: reverse,
            expectedRevision: data.story.revision,
          })
          .expect(200)
      ).body;
      assert.deepEqual(
        reordered.chapters.map((c) => c.id),
        reverse,
      );
      assert.deepEqual(
        reordered.chapters.map((c) => c.position),
        [1, 2, 3],
      );
      assert.equal(reordered.story.revision, data.story.revision + 1);
      assert.equal(reordered.chapters[0].revision, 2);
      assert.equal(reordered.chapters[1].revision, 1);
      assert.equal(
        (
          await a
            .write("put", base + "/chapters/order", {
              chapterIds: reverse,
              expectedRevision: reordered.story.revision,
            })
            .expect(200)
        ).body.story.revision,
        reordered.story.revision,
      );
      for (const ids of [
        [],
        [reverse[0], reverse[0], reverse[2]],
        [999999999, ...reverse.slice(1)],
      ])
        await a
          .write("put", base + "/chapters/order", {
            chapterIds: ids,
            expectedRevision: reordered.story.revision,
          })
          .expect(400);
      await a
        .write("put", base + "/chapters/order", {
          chapterIds: old.map((c) => c.id),
          expectedRevision: data.story.revision,
        })
        .expect(409);
      await a
        .write("put", base + "/chapters/" + old[0].id, {
          title: "Stale after reorder",
          summary: "",
          expectedRevision: 1,
        })
        .expect(409);
      const removed = (
        await a
          .write("delete", base + "/chapters/" + reverse[0], {
            expectedRevision: 2,
            expectedStoryRevision: reordered.story.revision,
          })
          .expect(200)
      ).body;
      assert.deepEqual(
        removed.chapters.map((c) => c.position),
        [1, 2],
      );
      const appended = (await chapter(a, removed.story, "New")).body;
      assert.equal(appended.chapters[2].position, 3);
      assert.ok(appended.chapter.id > Math.max(...old.map((c) => c.id)));
      assert.ok(
        (
          await f.db
            .prepare("SELECT chapter_number FROM chapters WHERE id=?")
            .get(reverse[0])
        ).chapter_number >= 1000,
      );
    }));
  test(`${kind}: concurrent membership/order writes and suspension races serialize safely`, () =>
    run(async (f) => {
      const a = await creator(f),
        story = (await create(a)).body.story,
        base = `/creator/stories/${story.id}`;
      const creates = await Promise.all([
        chapter(a, story, "One"),
        chapter(a, story, "Two"),
      ]);
      assert.deepEqual(creates.map((r) => r.status).sort(), [201, 409]);
      let data = creates.find((r) => r.status === 201).body;
      data = (await chapter(a, data.story, "Another")).body;
      const result = await Promise.all([
        a.write("delete", base + "/chapters/" + data.chapters[0].id, {
          expectedRevision: data.chapters[0].revision,
          expectedStoryRevision: data.story.revision,
        }),
        a.write("put", base + "/chapters/order", {
          chapterIds: data.chapters.map((c) => c.id).reverse(),
          expectedRevision: data.story.revision,
        }),
      ]);
      assert.deepEqual(result.map((r) => r.status).sort(), [200, 409]);
      const latest = (await a.get(base)).body;
      const [edit] = await Promise.all([
        a.write("put", base, {
          ...meta,
          title: "Racing suspension",
          expectedRevision: latest.story.revision,
        }),
        provisionIdentity(f.db, "status", a.data.user.id, "suspended"),
      ]);
      assert.ok([200, 403].includes(edit.status));
      await a
        .write("put", base, {
          ...meta,
          expectedRevision: latest.story.revision + 1,
        })
        .expect(403);
    }));
  test(`${kind}: allocation, receipts, ordering and revisions roll back together on real constraint failures`, () =>
    run(async (f) => {
      const a = await creator(f),
        service = draftService(f.db);
      let data = (await create(a)).body;
      const before = (
        await f.db
          .prepare(
            "SELECT next_id FROM creator_id_allocations WHERE kind='chapter'",
          )
          .get()
      ).next_id;
      const key = randomUUID();
      await assert.rejects(
        f.db.transaction(async () => {
          await service.addChapter(
            a.data.user,
            data.story.id,
            { title: "Rollback", summary: "" },
            key,
            1,
          );
          throw Error("rollback");
        }),
        /rollback/,
      );
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT next_id FROM creator_id_allocations WHERE kind='chapter'",
            )
            .get()
        ).next_id,
        before,
      );
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT COUNT(*) AS n FROM draft_create_receipts WHERE request_id=?",
            )
            .get(key)
        ).n,
        0,
      );
      data = (await chapter(a, data.story, "One")).body;
      data = (await chapter(a, data.story, "Two")).body;
      const original = data;
      await assert.rejects(
        f.db.transaction(async () => {
          await service.reorder(
            a.data.user,
            data.story.id,
            data.chapters.map((c) => c.id).reverse(),
            data.story.revision,
          );
          await f.db
            .prepare(
              "INSERT INTO chapters(id,story_id,chapter_number,title,audio_url,duration_seconds) VALUES(999999998,?,1,'Duplicate','',1)",
            )
            .run(data.story.id);
        }),
      );
      assert.deepEqual(
        (await a.get("/creator/stories/" + data.story.id)).body,
        { story: original.story, chapters: original.chapters },
      );
    }));
  test(`${kind}: server IDs skip existing rows and remain unique across creators and seed runs`, () =>
    run(async (f) => {
      const a = await creator(f),
        b = await creator(f);
      await f.db
        .prepare(
          "INSERT INTO stories(id,title,description,genre,language,author,tagline,color,symbol,popularity,ownership_kind,owner_id) VALUES(900000000,'Occupied','','Test','en','Creator','','#abc','radio',0,'creator',?)",
        )
        .run(b.data.user.id);
      const results = await Promise.all([
        create(a),
        create(b),
        create(a),
        create(b),
      ]);
      assert.ok(results.every((r) => r.status === 201));
      const ids = results.map((r) => r.body.story.id);
      assert.equal(new Set(ids).size, 4);
      assert.ok(ids.every((id) => id > 900000000));
      await seedCatalog(f.db);
      assert.equal(
        (
          await f.db
            .prepare("SELECT title FROM stories WHERE id=900000000")
            .get()
        ).title,
        "Occupied",
      );
    }));
  test(`${kind}: drafts stay invisible to every listener catalog, streaming and collection API`, () =>
    run(async (f) => {
      const a = await creator(f),
        story = (await create(a)).body.story,
        added = (await chapter(a, story)).body,
        c = added.chapter.id,
        anon = await f.client();
      for (const user of [a, anon]) {
        for (const path of [
          "/stories",
          "/stories?q=Private",
          "/recommendations",
        ])
          assert.equal(
            (await user.get(path).expect(200)).body.stories.some(
              (s) => s.id === story.id,
            ),
            false,
          );
        assert.equal(
          (await user.get("/genres")).body.genres.includes(meta.genre),
          false,
        );
        for (const path of [
          `/stories/${story.id}`,
          `/stories/${story.id}/chapters`,
          `/chapters/${c}/metadata`,
          `/chapters/${c}/stream`,
        ])
          await user.get(path).expect(404);
        await user.agent.head(`/api/chapters/${c}/stream`).expect(404);
        await user.agent
          .get(`/api/chapters/${c}/stream`)
          .set("Range", "bytes=0-99")
          .expect(404);
        await user.agent.get(`/audio/${story.id}-1.wav`).expect(404);
      }
      await a.write("put", "/library/" + story.id).expect(404);
      const p = (await a.write("post", "/playlists", { name: "No drafts" }))
        .body.playlist;
      await a
        .write("put", `/playlists/${p.id}/stories/${story.id}`)
        .expect(404);
      await a.get("/progress/" + c).expect(404);
      await a
        .write("put", "/progress/" + c, {
          positionSeconds: 0,
          expectedRevision: 0,
          clientId: randomUUID(),
          sequence: 1,
        })
        .expect(404);
      await a
        .write("post", "/analytics/events", {
          id: randomUUID(),
          type: "listening_interval",
          chapterId: c,
          listeningSeconds: 1,
          playbackRate: 1,
        })
        .expect(404);
      assert.match(
        (await a.get("/creator/stories/" + story.id)).headers["cache-control"],
        /private.*no-store/,
      );
      const pub = (await a.get("/stories/1")).body.story;
      assert.equal(Object.hasOwn(pub, "draft_revision"), false);
      const pubChapter = (await a.get("/stories/1/chapters")).body.chapters[0];
      assert.equal(Object.hasOwn(pubChapter, "draft_revision"), false);
    }));
  test(`${kind}: draft migrations preserve populated catalog and initialize allocation above existing reserved IDs`, () =>
    run(async (f) => {
      const a = await creator(f);
      await a.write("put", "/library/1").expect(200);
      const pub = (await a.get("/stories/1")).body;
      await f.db
        .prepare(
          "INSERT INTO stories(id,title,description,genre,author,tagline,color,symbol,popularity,ownership_kind,owner_id) VALUES(900000042,'Existing creator','','Test','Creator','','#abc','radio',0,'creator',?)",
        )
        .run(a.data.user.id);
      // Remove later dependent publication tables only in this disposable predecessor fixture.
      for (const table of [
        "publication_receipts",
        "publication_audit",
        "publication_chapters",
        "story_publications",
      ])
        await f.db.prepare(`DROP TABLE ${table}`).run();
      await f.db
        .prepare("DELETE FROM schema_migrations WHERE version=?")
        .run(kind === "postgres" ? "018_publishing.sql" : "019_publishing.sql");
      await f.db.prepare("DROP TABLE private_media_outputs").run();
      await f.db.prepare("DROP TABLE private_processing_intents").run();
      await f.db.prepare("DROP INDEX processing_asset_binding_idx").run();
      await f.db
        .prepare("ALTER TABLE background_jobs DROP COLUMN dispatch_topic")
        .run();
      await f.db
        .prepare("DELETE FROM schema_migrations WHERE version=?")
        .run(
          kind === "postgres"
            ? "017_private_processing.sql"
            : "018_private_processing.sql",
        );
      await f.db.prepare("DROP TABLE private_media_heads").run();
      await f.db.prepare("DROP TABLE private_media_assets").run();
      await f.db
        .prepare("DELETE FROM schema_migrations WHERE version=?")
        .run(
          kind === "postgres"
            ? "016_private_media.sql"
            : "017_private_media.sql",
        );
      await f.db.prepare("DROP TABLE draft_create_receipts").run();
      await f.db.prepare("DROP TABLE creator_id_allocations").run();
      for (const index of [
        "creator_drafts_list_idx",
        "draft_chapter_order_idx",
        "draft_story_owner_key",
        ...(kind === "sqlite" ? ["draft_chapter_parent_key"] : []),
      ])
        await f.db.prepare("DROP INDEX " + index).run();
      for (const column of ["draft_state", "draft_revision", "language"])
        await f.db.prepare("ALTER TABLE stories DROP COLUMN " + column).run();
      for (const column of ["draft_revision", "draft_removed", "summary"])
        await f.db.prepare("ALTER TABLE chapters DROP COLUMN " + column).run();
      await f.db
        .prepare("DELETE FROM schema_migrations WHERE version=?")
        .run(
          kind === "postgres"
            ? "015_creator_drafts.sql"
            : "016_creator_drafts.sql",
        );
      await migrate(f.db);
      await migrate(f.db);
      assert.deepEqual((await a.get("/stories/1")).body, pub);
      assert.equal((await a.get("/library")).body.stories.length, 1);
      const restored = (await a.get("/creator/stories/900000042")).body;
      assert.equal(restored.story.revision, 1);
      assert.equal(restored.story.language, "und");
      assert.equal((await create(a)).body.story.id, 900000043);
    }));
  test(`${kind}: draft limits and database relationship constraints cannot be bypassed`, () =>
    run(async (f) => {
      const a = await creator(f),
        story = (await create(a)).body.story,
        other = (await create(a)).body.story;
      for (let i = 0; i < 100; i++)
        await f.db
          .prepare(
            "INSERT INTO chapters(id,story_id,chapter_number,title,audio_url,duration_seconds) VALUES(?,?,?,'Fixture','',1)",
          )
          .run(910000000 + i, story.id, i + 1);
      await chapter(a, story).expect(409);
      await f.db
        .prepare("UPDATE stories SET draft_revision=? WHERE id=?")
        .run(Number.MAX_SAFE_INTEGER, other.id);
      await a
        .write("put", "/creator/stories/" + other.id, {
          ...meta,
          expectedRevision: Number.MAX_SAFE_INTEGER,
        })
        .expect(409);
      await f.db
        .prepare(
          "UPDATE chapters SET draft_removed=1,chapter_number=chapter_number+1000 WHERE story_id=?",
        )
        .run(story.id);
      for (let i = 100; i < 500; i++)
        await f.db
          .prepare(
            "INSERT INTO chapters(id,story_id,chapter_number,title,audio_url,duration_seconds,draft_removed) VALUES(?,?,?,'Retained fixture','',1,1)",
          )
          .run(910000000 + i, story.id, 1001 + i);
      await chapter(a, story).expect(409);
      for (let i = 0; i < 98; i++)
        await f.db
          .prepare(
            "INSERT INTO stories(id,title,description,genre,author,tagline,color,symbol,popularity,ownership_kind,owner_id,draft_state) SELECT ?,title,description,genre,author,tagline,color,symbol,popularity,'creator',?,'archived' FROM stories WHERE id=?",
          )
          .run(920000000 + i, a.data.user.id, story.id);
      await create(a).expect(409);
      const b = await creator(f);
      await assert.rejects(
        f.db
          .prepare(
            "INSERT INTO draft_create_receipts(user_id,request_id,request_hash,kind,story_id) VALUES(?,?,?,'story',?)",
          )
          .run(b.data.user.id, randomUUID(), "a".repeat(64), story.id),
      );
      await assert.rejects(
        f.db
          .prepare(
            "INSERT INTO draft_create_receipts(user_id,request_id,request_hash,kind,story_id,chapter_id) VALUES(?,?,?,'chapter',?,?)",
          )
          .run(
            a.data.user.id,
            randomUUID(),
            "a".repeat(64),
            other.id,
            910000000,
          ),
      );
      await assert.rejects(
        f.db
          .prepare("UPDATE stories SET draft_state='published' WHERE id=?")
          .run(story.id),
      );
    }));
}
