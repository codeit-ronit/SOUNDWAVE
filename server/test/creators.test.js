import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, backends, password } from "./phase2-helpers.js";
import { authorizationService } from "../services/authorization.js";
import { creatorService } from "../services/creators.js";
import { provisionIdentity } from "../services/creator-operator.js";
import { migrate } from "../database/migrate.js";
import { seedCatalog } from "../database/seed.js";
import { seedDatabase } from "../db.js";
import { enqueueCatalogMedia } from "../media/queue.js";
const profile = { displayName: "Creator One", bio: "Stories for listeners." };
async function registered(f) {
  const c = await f.client();
  await c.auth("demo");
  await c.auth("register", {
    email: `${randomUUID()}@example.com`,
    password,
    displayName: "Listener",
  });
  return c;
}
async function ownedStory(f, owner, id = 50000) {
  await f.db
    .prepare(
      "INSERT INTO stories(id,title,genre,author,tagline,description,color,symbol,popularity,ownership_kind,owner_id) VALUES(?,'Private creator story','Private Genre','Creator','','','#abc','radio',0,'creator',?)",
    )
    .run(id, owner);
  await f.db
    .prepare(
      "INSERT INTO chapters(id,story_id,chapter_number,title,audio_url,duration_seconds) VALUES(?,?,1,'Private chapter','/audio/50000-1.wav',35)",
    )
    .run(500001, id);
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
  test(`${kind}: creator eligibility, guest upgrade and duplicate activation preserve listener data`, () =>
    run(async (f) => {
      const c = await f.client();
      await c.get("/creator").expect(401);
      await c.write("post", "/creator", profile).expect(401);
      await c.auth("demo");
      const id = c.data.user.id;
      assert.equal((await c.get("/creator")).body.eligible, false);
      await c.write("post", "/creator", profile).expect(403);
      await c.write("put", "/library/1").expect(200);
      await c.write("put", "/settings", { playbackSpeed: 1.5 }).expect(200);
      const list = (await c.write("post", "/playlists", { name: "Kept" })).body
        .playlist;
      await c.write("put", `/playlists/${list.id}/stories/1`).expect(200);
      await c
        .write("put", "/progress/101", {
          expectedRevision: 0,
          clientId: randomUUID(),
          sequence: 1,
          positionSeconds: 8,
        })
        .expect(200);
      await c
        .write("delete", "/history/101", { expectedRevision: 1 })
        .expect(200);
      await c.auth("register", {
        email: `${randomUUID()}@example.com`,
        password,
        displayName: "Upgraded",
      });
      assert.equal(c.data.user.id, id);
      assert.equal((await c.get("/creator")).body.creator, null);
      const first = (await c.write("post", "/creator", profile).expect(200))
        .body;
      assert.equal(first.creator.status, "active");
      assert.equal(first.platformRole, "listener");
      assert.deepEqual(
        (
          await c
            .write("post", "/creator", {
              displayName: "Different",
              bio: "Ignored duplicate",
            })
            .expect(200)
        ).body,
        first,
      );
      assert.equal((await c.get("/library")).body.stories.length, 1);
      assert.equal((await c.get("/settings")).body.settings.playbackSpeed, 1.5);
      assert.equal(
        (await c.get(`/playlists/${list.id}`)).body.stories.length,
        1,
      );
      assert.equal((await c.get("/progress/101")).body.progress.removed, true);
    }));
  test(`${kind}: creator validation rejects forged roles, owners, selectors, invalid profiles and CSRF`, () =>
    run(async (f) => {
      const a = await registered(f);
      for (const body of [
        { ...profile, role: "admin" },
        { ...profile, ownerId: randomUUID() },
        { ...profile, status: "active" },
        { displayName: " ", bio: "" },
        { displayName: "a".repeat(81), bio: "" },
        { displayName: "OK", bio: "a".repeat(1001) },
        { displayName: "bad\u0000", bio: "" },
        { displayName: "OK", bio: "bad\u0001" },
        { displayName: "OK" },
        [],
      ])
        await a.write("post", "/creator", body).expect(400);
      await a.get("/creator?ownerId=forged").expect(400);
      await a.write("post", "/creator?role=admin", profile).expect(400);
      await a.agent.post("/api/creator").send(profile).expect(403);
      await a.write("put", "/creator/" + randomUUID(), profile).expect(404);
      await a.agent
        .get("/api/creator")
        .set("X-Session-User", randomUUID())
        .expect(409);
      const anon = await f.client();
      assert.equal(
        (
          await anon.auth("register", {
            email: `${randomUUID()}@example.com`,
            password,
            displayName: "No admin",
            role: "admin",
          })
        ).status,
        400,
      );
      await a
        .write("post", "/creator", {
          displayName: "😀".repeat(80),
          bio: "Line one\nLine two",
        })
        .expect(200);
    }));
  test(`${kind}: creator profiles are private and cannot be reassigned or edited across accounts`, () =>
    run(async (f) => {
      const a = await registered(f),
        b = await registered(f);
      await a.write("post", "/creator", profile).expect(200);
      assert.equal((await b.get("/creator")).body.creator, null);
      await b.write("put", "/creator", profile).expect(403);
      await b
        .write("post", "/creator", {
          displayName: "Other",
          bio: "Other private bio",
        })
        .expect(200);
      await b
        .write("put", "/creator", {
          displayName: "Other edited",
          bio: "Own profile",
        })
        .expect(200);
      assert.deepEqual((await a.get("/creator")).body.creator.bio, profile.bio);
      for (const key of [
        "id",
        "userId",
        "owner_id",
        "account_kind",
        "platformRole",
      ])
        await b
          .write("put", "/creator", { ...profile, [key]: a.data.user.id })
          .expect(400);
      assert.match(
        (await a.get("/creator")).headers["cache-control"],
        /private.*no-store/,
      );
    }));
  test(`${kind}: deactivation, suspension and role revocation take effect without changing listener sessions`, () =>
    run(async (f) => {
      const a = await registered(f),
        id = a.data.user.id;
      await a.write("post", "/creator", profile).expect(200);
      const inactive = (
        await a.write("post", "/creator/deactivate", {}).expect(200)
      ).body;
      assert.equal(inactive.creator.status, "inactive");
      assert.deepEqual(
        (await a.write("post", "/creator/deactivate", {}).expect(200)).body,
        inactive,
      );
      await a.write("put", "/creator", profile).expect(403);
      assert.equal(
        (
          await a
            .write("post", "/creator", {
              displayName: "Not overwritten",
              bio: "",
            })
            .expect(200)
        ).body.creator.displayName,
        profile.displayName,
      );
      await provisionIdentity(f.db, "status", id, "suspended");
      for (const [method, path, body] of [
        ["put", "/creator", profile],
        ["post", "/creator", profile],
        ["post", "/creator/deactivate", {}],
      ])
        await a.write(method, path, body).expect(403);
      assert.equal((await a.get("/creator")).body.creator.status, "suspended");
      await a.write("put", "/library/1").expect(200);
      const auth = authorizationService(f.db);
      await assert.rejects(
        auth.staff({ ...a.data.user, role: "admin" }, ["admin"]),
        (e) => e.status === 403,
      );
      await provisionIdentity(f.db, "role", id, "admin");
      await auth.staff(a.data.user, ["admin"]);
      await assert.rejects(
        auth.staff(a.data.user, []),
        (e) => e.status === 403,
      );
      await provisionIdentity(f.db, "role", id, "listener");
      await assert.rejects(
        auth.staff(a.data.user, ["admin"]),
        (e) => e.status === 403,
      );
      await provisionIdentity(f.db, "status", id, "active");
      await a.write("put", "/creator", profile).expect(200);
    }));
  test(`${kind}: creator authorization requires both active role and exact story ownership, including staff`, () =>
    run(async (f) => {
      const a = await registered(f),
        b = await registered(f),
        auth = authorizationService(f.db);
      await a.write("post", "/creator", profile).expect(200);
      await b.write("post", "/creator", profile).expect(200);
      await ownedStory(f, a.data.user.id);
      assert.equal(
        (await auth.ownedStory(a.data.user, 50000)).owner_id,
        a.data.user.id,
      );
      for (const id of [50000, 1, 999999])
        await assert.rejects(
          auth.ownedStory(b.data.user, id),
          (e) => e.status === 404,
        );
      await provisionIdentity(f.db, "role", b.data.user.id, "admin");
      await assert.rejects(
        auth.ownedStory(b.data.user, 50000),
        (e) => e.status === 404,
      );
      await provisionIdentity(f.db, "status", a.data.user.id, "suspended");
      await assert.rejects(
        auth.ownedStory(a.data.user, 50000),
        (e) => e.status === 403,
      );
      await assert.rejects(auth.creator(null), (e) => e.status === 401);
    }));
  test(`${kind}: database constraints prevent guest privilege, invalid roles and inconsistent ownership`, () =>
    run(async (f) => {
      const guest = await f.client();
      await guest.auth("demo");
      const a = await registered(f);
      await assert.rejects(
        f.db
          .prepare("UPDATE users SET platform_role='admin' WHERE id=?")
          .run(guest.data.user.id),
      );
      await assert.rejects(
        f.db
          .prepare(
            "INSERT INTO creator_profiles(user_id,display_name) VALUES(?,'Guest')",
          )
          .run(guest.data.user.id),
      );
      await assert.rejects(
        f.db
          .prepare("UPDATE users SET platform_role='superuser' WHERE id=?")
          .run(a.data.user.id),
      );
      await assert.rejects(
        provisionIdentity(f.db, "role", guest.data.user.id, "admin"),
        (e) => e.status === 403,
      );
      await a.write("post", "/creator", profile).expect(200);
      await ownedStory(f, a.data.user.id);
      await assert.rejects(
        f.db.prepare("UPDATE stories SET owner_id=NULL WHERE id=50000").run(),
      );
      await assert.rejects(
        f.db
          .prepare("UPDATE stories SET ownership_kind='system' WHERE id=50000")
          .run(),
      );
      await assert.rejects(
        f.db
          .prepare("DELETE FROM creator_profiles WHERE user_id=?")
          .run(a.data.user.id),
      );
      await assert.rejects(
        f.db
          .prepare("UPDATE creator_profiles SET bio=? WHERE user_id=?")
          .run("a".repeat(1001), a.data.user.id),
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT owner_id FROM stories WHERE id=50000")
            .get()
        ).owner_id,
        a.data.user.id,
      );
    }));
  test(`${kind}: creator-owned catalog entries stay private across discovery, chapters, streams and listener writes`, () =>
    run(async (f) => {
      const a = await registered(f);
      await a.write("post", "/creator", profile).expect(200);
      await ownedStory(f, a.data.user.id);
      const anon = await f.client();
      for (const c of [a, anon]) {
        assert.equal(
          (await c.get("/stories")).body.stories.some((s) => s.id === 50000),
          false,
        );
        assert.equal(
          (await c.get("/recommendations")).body.stories.some(
            (s) => s.id === 50000,
          ),
          false,
        );
        assert.equal(
          (await c.get("/genres")).body.genres.includes("Private Genre"),
          false,
        );
        for (const path of [
          "/stories/50000",
          "/stories/50000/chapters",
          "/chapters/500001/metadata",
          "/chapters/500001/stream",
        ])
          await c.get(path).expect(404);
        await c.agent.head("/api/chapters/500001/stream").expect(404);
        await c.agent.get("/audio/50000-1.wav").expect(404);
      }
      await a.write("put", "/library/50000").expect(404);
      await a.get("/progress/500001").expect(404);
      await a
        .write("put", "/progress/500001", {
          expectedRevision: 0,
          positionSeconds: 3,
          clientId: randomUUID(),
          sequence: 1,
        })
        .expect(404);
      const list = (
        await a.write("post", "/playlists", { name: "Public only" })
      ).body.playlist;
      await a.write("put", `/playlists/${list.id}/stories/50000`).expect(404);
      const story = (await a.get("/stories/1")).body.story;
      assert.equal(Object.hasOwn(story, "owner_id"), false);
      assert.equal(Object.hasOwn(story, "ownership_kind"), false);
      await a.agent
        .get("/api/chapters/101/stream")
        .set("Range", "bytes=0-99")
        .expect(206);
    }));
  test(`${kind}: startup seeding preserves creator-owned stories and chapter collisions`, () =>
    run(async (f) => {
      const a = await registered(f);
      await a.write("post", "/creator", profile).expect(200);
      await f.db
        .prepare(
          "UPDATE stories SET owner_id=?,ownership_kind='creator',title='Retained private title' WHERE id=1",
        )
        .run(a.data.user.id);
      await f.db
        .prepare(
          "UPDATE chapters SET title='Retained private chapter' WHERE id=101",
        )
        .run();
      await seedCatalog(f.db);
      if (kind === "sqlite") seedDatabase(f.db.raw);
      assert.equal(
        (await f.db.prepare("SELECT title FROM stories WHERE id=1").get())
          .title,
        "Retained private title",
      );
      assert.equal(
        (await f.db.prepare("SELECT title FROM chapters WHERE id=101").get())
          .title,
        "Retained private chapter",
      );
      await f.db.prepare("DELETE FROM chapters WHERE id=201").run();
      await f.db
        .prepare(
          "INSERT INTO chapters(id,story_id,chapter_number,title,audio_url,duration_seconds) VALUES(201,1,99,'Private ID collision','/audio/1-1.wav',35)",
        )
        .run();
      await seedCatalog(f.db);
      if (kind === "sqlite") seedDatabase(f.db.raw);
      assert.equal(
        (await f.db.prepare("SELECT title FROM chapters WHERE id=201").get())
          .title,
        "Private ID collision",
      );
      const queued = [];
      await enqueueCatalogMedia(f.db, {
        add: async (_type, payload) => queued.push(payload.chapterId),
      });
      assert.ok(queued.length > 0);
      assert.equal(
        queued.some((id) => [101, 102, 201].includes(id)),
        false,
      );
    }));
  test(`${kind}: concurrent onboarding and suspension serialize; failed creator transactions roll back`, () =>
    run(async (f) => {
      const a = await registered(f),
        id = a.data.user.id;
      const both = await Promise.all([
        a.write("post", "/creator", profile),
        a.write("post", "/creator", profile),
      ]);
      assert.deepEqual(
        both.map((r) => r.status),
        [200, 200],
      );
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT COUNT(*) AS n FROM creator_profiles WHERE user_id=?",
            )
            .get(id)
        ).n,
        1,
      );
      const [edit] = await Promise.all([
        a.write("put", "/creator", {
          displayName: "Racing edit",
          bio: "Retained",
        }),
        provisionIdentity(f.db, "status", id, "suspended"),
      ]);
      assert.ok([200, 403].includes(edit.status));
      assert.equal((await a.get("/creator")).body.creator.status, "suspended");
      const b = await registered(f);
      await assert.rejects(
        f.db.transaction(async () => {
          await creatorService(f.db).activate(b.data.user, "Rollback", "");
          throw Error("rollback");
        }),
        /rollback/,
      );
      assert.equal((await b.get("/creator")).body.creator, null);
    }));
  test(`${kind}: additive creator migration preserves populated listener state and marks catalog provenance`, () =>
    run(async (f) => {
      const a = await registered(f);
      await a.write("put", "/library/1").expect(200);
      await a
        .write("put", "/progress/101", {
          expectedRevision: 0,
          positionSeconds: 8,
          clientId: randomUUID(),
          sequence: 1,
        })
        .expect(200);
      await a
        .write("delete", "/history/101", { expectedRevision: 1 })
        .expect(200);
      const before = (await a.get("/progress/101")).body.progress;
      await f.db.prepare("DROP TABLE private_media_heads").run();
      await f.db.prepare("DROP TABLE private_media_assets").run();
      await f.db.prepare("DROP INDEX creator_drafts_list_idx").run();
      await f.db.prepare("DROP TABLE draft_create_receipts").run();
      await f.db.prepare("DROP INDEX draft_story_owner_key").run();
      await f.db
        .prepare("ALTER TABLE stories DROP COLUMN ownership_kind")
        .run();
      await f.db.prepare("DROP INDEX stories_owner_idx").run();
      await f.db.prepare("ALTER TABLE stories DROP COLUMN owner_id").run();
      await f.db.prepare("DROP TABLE creator_profiles").run();
      await f.db.prepare("DROP INDEX users_identity_kind_idx").run();
      await f.db.prepare("ALTER TABLE users DROP COLUMN platform_role").run();
      const file =
        kind === "postgres"
          ? "014_creator_identity.sql"
          : "015_creator_identity.sql";
      await f.db
        .prepare("DELETE FROM schema_migrations WHERE version=?")
        .run(file);
      await f.db
        .prepare(
          "INSERT INTO story_sources(story_id,provider,external_id,source_url,archive_identifier,narrator,content_hash,refreshed_at) VALUES(2,'librivox',200,'https://librivox.org/fixture/','fixture','Narrator',?,?)",
        )
        .run("a".repeat(64), new Date().toISOString());
      await migrate(f.db);
      await migrate(f.db);
      assert.deepEqual((await a.get("/progress/101")).body.progress, before);
      assert.equal((await a.get("/library")).body.stories.length, 1);
      assert.equal(
        (
          await f.db
            .prepare("SELECT ownership_kind FROM stories WHERE id=2")
            .get()
        ).ownership_kind,
        "external",
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT ownership_kind FROM stories WHERE id=1")
            .get()
        ).ownership_kind,
        "system",
      );
      assert.equal((await a.get("/creator")).body.platformRole, "listener");
    }));
}
