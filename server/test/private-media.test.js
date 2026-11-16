import { setup, reserve } from "./private-media-helpers.js";
import { wav } from "./private-wav-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  readdir,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { setImmediate as turn } from "node:timers/promises";
import { backends, fixture, password } from "./phase2-helpers.js";
import { privateMediaService } from "../services/private-media.js";
import { provisionIdentity } from "../services/creator-operator.js";
import { migrate } from "../database/migrate.js";
import { localPrivateStorage } from "../storage/local-private.js";
const upload = (f, id, b = wav()) =>
  f.c.write("put", `${f.path}/${id}/bytes`, b).set("Content-Type", "audio/wav");
async function until(fn) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (await fn()) return;
    await turn();
  }
  throw Error("Timed out waiting for upload state");
}
for (const kind of backends) {
  test(`${kind}: private upload persists validated PCM, checksums and owner-only range preview`, async () => {
    const f = await setup(kind);
    try {
      const b = wav(),
        a = (
          await reserve(f, b).then((r) => {
            assert.equal(r.status, 201, JSON.stringify(r.body));
            return r;
          })
        ).body.asset;
      const simultaneous = await Promise.all([
        upload(f, a.id, b),
        upload(f, a.id, b),
      ]);
      assert.ok(simultaneous.every((r) => [200, 409].includes(r.status)));
      const done = simultaneous.find((r) => r.status === 200);
      assert.ok(done);
      assert.equal(done.body.asset.status, "validated");
      assert.equal(
        done.body.asset.checksum,
        createHash("sha256").update(b).digest("hex"),
      );
      assert.equal(done.body.asset.durationSeconds, 0.1);
      const status = (await f.c.get(f.path).expect(200)).body;
      assert.equal(status.headRevision, 1);
      assert.equal(status.current.id, a.id);
      assert.equal(status.usedBytes, b.length);
      assert.equal(JSON.stringify(status).includes("object_key"), false);
      const p = `${f.path}/${a.id}/preview`;
      const preview = await f.c.get(p).expect(200);
      assert.deepEqual(preview.body, b);
      assert.match(preview.headers["cache-control"], /no-store/);
      await f.c.agent
        .head("/api" + p)
        .expect(200)
        .expect("Content-Length", String(b.length));
      await f.c
        .get(p)
        .set("Range", "bytes=2-11")
        .expect(206)
        .expect("Content-Range", `bytes 2-11/${b.length}`);
      await f.c.get(p).set("Range", "bytes=999999-").expect(416);
      await upload(f, a.id, b).expect(200);
      assert.equal((await f.c.get(f.path)).body.usedBytes, b.length);
      await f.c.get(`/stories/${f.s.id}`).expect(404);
      await f.c.get(`/chapters/${f.ch.id}/metadata`).expect(404);
      await f.c.get(`/chapters/${f.ch.id}/stream`).expect(404);
      await f.c.agent.get(`/audio/${f.s.id}-1.wav`).expect(404);
      assert.equal((await readdir(f.config.privateMediaRoot)).length, 1);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: private media rejects forged ownership, inactive creators, CSRF and origins`, async () => {
    const f = await setup(kind);
    try {
      const a = (await reserve(f)).body.asset,
        other = await f.client();
      await other.auth("register", {
        email: `${randomUUID()}@example.com`,
        password,
        displayName: "Other",
      });
      await other.write("post", "/creator", { displayName: "Other", bio: "" });
      const missing = (await other.get(`${f.path}/${randomUUID()}`).expect(404))
        .body;
      assert.deepEqual(
        (await other.get(`${f.path}/${a.id}`).expect(404)).body,
        missing,
      );
      await other
        .write("put", `${f.path}/${a.id}/bytes`, wav())
        .set("Content-Type", "audio/wav")
        .expect(404);
      await other
        .write("delete", `${f.path}/${a.id}`, { expectedRevision: 1 })
        .expect(404);
      const guest = await f.client();
      await guest.get(f.path).expect(401);
      await guest.auth("demo", {});
      await guest.get(f.path).expect(403);
      await f.c.agent
        .put(`/api${f.path}/${a.id}/bytes`)
        .set("Content-Type", "audio/wav")
        .send(wav())
        .expect(403);
      await f.c
        .write("put", `${f.path}/${a.id}/bytes`, wav())
        .set("Content-Type", "audio/wav")
        .set("Origin", "https://evil.example")
        .expect(403);
      await reserve(f, wav(), { ownerId: other.data.user.id }).then((r) =>
        assert.equal(r.status, 400),
      );
      await f.c.get(f.path + "/not-a-uuid").expect(400);
      await f.c.get(f.path + "?path=../../secret").expect(400);
      await f.db
        .prepare("UPDATE private_media_assets SET expires_at=? WHERE id=?")
        .run("2000-01-01T00:00:00.000Z", a.id);
      await provisionIdentity(f.db, "status", f.c.data.user.id, "suspended");
      await f.c
        .write("post", f.path, {
          requestId: randomUUID(),
          byteSize: wav().length,
          expectedChapterRevision: 1,
          expectedHeadRevision: 0,
        })
        .expect(403);
      const untouched = await f.db
        .prepare(
          "SELECT status,revision,storage_released FROM private_media_assets WHERE id=?",
        )
        .get(a.id);
      assert.deepEqual(untouched, {
        status: "reserved",
        revision: 1,
        storage_released: 0,
      });
      await upload(f, a.id).expect(403);
      await f.c.get(`${f.path}/${a.id}/preview`).expect(403);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: private upload validates real bytes, truncated WAV, MIME, limits and empty inputs`, async () => {
    const f = await setup(kind, { uploadMaxBytes: 20000 });
    try {
      for (const b of [
        Buffer.from("not audio"),
        wav().subarray(0, 100),
        Buffer.from(wav()),
      ]) {
        if (b.length === wav().length) b.writeUInt32LE(1, 28);
        const a = (await reserve(f, b)).body.asset;
        await upload(f, a.id, b).expect(422);
        assert.equal((await f.c.get(f.path)).body.usedBytes, 0);
      }
      assert.equal((await reserve(f, Buffer.alloc(0))).status, 400);
      assert.equal((await reserve(f, Buffer.alloc(20001))).status, 400);
      const a = (await reserve(f)).body.asset;
      await f.c
        .write("put", `${f.path}/${a.id}/bytes`, wav())
        .set("Content-Type", "audio/mpeg")
        .expect(415);
      await upload(f, a.id, Buffer.alloc(0)).expect(400);
      assert.equal((await f.c.get(f.path)).body.usedBytes, 0);
      assert.deepEqual(await readdir(f.config.privateMediaRoot), []);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: quota reservation is shared, idempotent and safe across simultaneous chapters`, async () => {
    const f = await setup(kind, { creatorStorageBytes: 2500 });
    try {
      const second = (
        await f.c.write("post", `/creator/stories/${f.s.id}/chapters`, {
          title: "Second",
          summary: "",
          requestId: randomUUID(),
          expectedStoryRevision: f.s.revision,
        })
      ).body.chapter;
      const body = {
        requestId: randomUUID(),
        byteSize: wav().length,
        expectedChapterRevision: 1,
        expectedHeadRevision: 0,
      };
      const [a, b] = await Promise.all([
        f.c.write("post", f.path, body),
        f.c.write(
          "post",
          `/creator/stories/${f.s.id}/chapters/${second.id}/media`,
          { ...body, requestId: randomUUID() },
        ),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [201, 409]);
      const accepted = a.status === 201 ? a : b,
        p =
          a.status === 201
            ? f.path
            : `/creator/stories/${f.s.id}/chapters/${second.id}/media`;
      const replay = await f.c.write(
        "post",
        p,
        a.status === 201
          ? body
          : { ...body, requestId: accepted.body.asset.requestId },
      );
      if (a.status === 201) {
        assert.equal(replay.status, 200);
        assert.equal(replay.body.asset.id, a.body.asset.id);
      }
      const key = await f.db
        .prepare("SELECT request_id FROM private_media_assets WHERE id=?")
        .get(accepted.body.asset.id);
      await f.c
        .write("post", p, { ...body, requestId: key.request_id })
        .expect(200);
      await f.c
        .write("post", p, { ...body, requestId: key.request_id, byteSize: 100 })
        .expect(409);
      assert.equal((await f.c.get(f.path)).body.usedBytes, wav().length);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: streaming byte limit, interruption and timeout release quota after cleanup`, async () => {
    const f = await setup(kind),
      server = f.app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      for (const mode of ["oversize", "interrupt", "timeout"]) {
        const a = (await reserve(f)).body.asset;
        const result = new Promise((resolve) => {
          const req = httpRequest(
            {
              hostname: "127.0.0.1",
              port: server.address().port,
              path: `/api${f.path}/${a.id}/bytes`,
              method: "PUT",
              headers: {
                Cookie: f.c.cookie,
                "X-CSRF-Token": f.c.data.csrfToken,
                "Content-Type": "audio/wav",
                "Transfer-Encoding": "chunked",
              },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode));
            },
          );
          req.on("error", () => resolve("disconnected"));
          if (mode === "oversize") req.end(Buffer.alloc(wav().length + 1));
          else {
            req.write(wav().subarray(0, 44));
            if (mode === "interrupt")
              void until(
                async () =>
                  (
                    await f.db
                      .prepare(
                        "SELECT status FROM private_media_assets WHERE id=?",
                      )
                      .get(a.id)
                  ).status === "uploading",
              ).then(() => req.destroy());
          }
        });
        const code = await result;
        if (mode === "oversize") assert.equal(code, 413);
        if (mode === "timeout") assert.equal(code, 408);
        await until(async () => (await f.c.get(f.path)).body.usedBytes === 0);
        const status = (await f.c.get(`${f.path}/${a.id}`)).body.asset;
        assert.equal(status.status, "failed");
      }
      assert.deepEqual(await readdir(f.config.privateMediaRoot), []);
    } finally {
      await new Promise((r) => server.close(r));
      await f.close();
    }
  });
  test(`${kind}: suspension and chapter changes during upload prevent attachment`, async () => {
    const f = await setup(kind);
    try {
      const a = (await reserve(f)).body.asset,
        claim = await f.service.claim(f.c.data.user, f.s.id, f.ch.id, a.id);
      await provisionIdentity(f.db, "status", f.c.data.user.id, "suspended");
      await f.service.quarantine(
        a.id,
        claim.token,
        wav().length,
        "a".repeat(64),
      );
      await assert.rejects(
        f.service.finish(
          f.c.data.user,
          f.s.id,
          f.ch.id,
          a.id,
          claim.token,
          { durationSeconds: 0.1 },
          "missing-session",
        ),
        (e) => e.status === 403,
      );
      await f.service.fail(a.id, claim.token, "CREATOR_INACTIVE");
      assert.equal(
        (
          await f.db
            .prepare(
              "SELECT asset_id FROM private_media_heads WHERE chapter_id=?",
            )
            .get(f.ch.id)
        ).asset_id,
        null,
      );
      await provisionIdentity(f.db, "status", f.c.data.user.id, "active");
      const next = (await reserve(f)).body.asset,
        claimed = await f.service.claim(
          f.c.data.user,
          f.s.id,
          f.ch.id,
          next.id,
        );
      await f.c
        .write("put", `/creator/stories/${f.s.id}/chapters/${f.ch.id}`, {
          title: "Changed",
          summary: "",
          expectedRevision: 1,
        })
        .expect(200);
      await f.service.quarantine(
        next.id,
        claimed.token,
        wav().length,
        "b".repeat(64),
      );
      const session = await f.db
        .prepare(
          "SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1",
        )
        .get(f.c.data.user.id);
      await assert.rejects(
        f.service.finish(
          f.c.data.user,
          f.s.id,
          f.ch.id,
          next.id,
          claimed.token,
          { durationSeconds: 0.1 },
          session.token_hash,
        ),
        (e) => e.mediaCode === "MEDIA_CONFLICT",
      );
      await f.service.fail(next.id, claimed.token, "MEDIA_CONFLICT");
    } finally {
      await f.close();
    }
  });
  test(`${kind}: replacement and delete races retain only a validated current asset`, async () => {
    const f = await setup(kind);
    try {
      const a = (await reserve(f)).body.asset,
        done = (await upload(f, a.id).expect(200)).body.asset;
      const b = (await reserve(f)).body.asset;
      const results = await Promise.all([
        upload(f, b.id),
        f.c.write("delete", `${f.path}/${a.id}`, {
          expectedRevision: done.revision,
        }),
      ]);
      assert.ok(results.every((r) => [200, 409].includes(r.status)));
      const status = (await f.c.get(f.path)).body;
      if (status.current) {
        assert.equal(status.current.id, b.id);
        assert.equal(status.current.status, "validated");
      }
      await f.service.sweep(f.c.data.user.id);
      const active = await f.db
        .prepare(
          "SELECT id FROM private_media_assets WHERE user_id=? AND status='validated'",
        )
        .all(f.c.data.user.id);
      assert.equal(active.length, status.current ? 1 : 0);
      const original = await f.db
        .prepare("SELECT * FROM private_media_assets WHERE id=?")
        .get(a.id);
      assert.equal(original.storage_released, 1);
      if (status.current) {
        await f.c
          .write("post", `/creator/stories/${f.s.id}/archive`, {
            expectedRevision: f.s.revision,
          })
          .expect(200);
        await f.c.get(`${f.path}/${b.id}/preview`).expect(404);
        await f.service.sweep();
        assert.equal((await f.c.get(f.path)).body.usedBytes, 0);
      }
    } finally {
      await f.close();
    }
  });
  test(`${kind}: storage failures retain quota until recoverable cleanup succeeds; abandoned leases expire`, async () => {
    const f = await setup(kind);
    try {
      const a = (await reserve(f)).body.asset;
      await writeFile(f.config.privateMediaRoot, "not a directory");
      await upload(f, a.id).expect(503);
      let state = (await f.c.get(f.path)).body;
      assert.equal(state.usedBytes, wav().length);
      assert.equal(state.recent[0].cleanupPending, true);
      await rm(f.config.privateMediaRoot);
      await f.service.sweep(f.c.data.user.id);
      assert.equal((await f.c.get(f.path)).body.usedBytes, 0);
      const next = (await reserve(f)).body.asset,
        claim = await f.service.claim(f.c.data.user, f.s.id, f.ch.id, next.id);
      const h = await f.service.storage.create(claim.a.object_key);
      await h.write(wav().subarray(0, 44));
      await h.close();
      await f.db
        .prepare("UPDATE private_media_assets SET lease_until=? WHERE id=?")
        .run("2000-01-01T00:00:00.000Z", next.id);
      await f.service.sweep();
      assert.equal((await f.c.get(f.path)).body.usedBytes, 0);
      assert.deepEqual(await readdir(f.config.privateMediaRoot), []);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: private media additive migration preserves populated drafts and listener state`, async () => {
    const f = await setup(kind);
    try {
      const before = (await f.c.get(`/creator/stories/${f.s.id}`)).body;
      await f.c.write("put", "/library/1").expect(200);
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
      await migrate(f.db);
      await migrate(f.db);
      assert.deepEqual(
        (await f.c.get(`/creator/stories/${f.s.id}`)).body,
        before,
      );
      assert.equal((await f.c.get("/library")).body.stories.length, 1);
      const a = (await reserve(f)).body.asset;
      await upload(f, a.id).expect(200);
    } finally {
      await f.close();
    }
  });
}
test("private storage rejects traversal, symlink objects/root, public roots and overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "private-storage-"));
  try {
    const root = join(dir, "objects"),
      s = localPrivateStorage(root),
      key = "a".repeat(64);
    await assert.rejects(s.create("../outside"));
    const h = await s.create(key);
    await h.write("test");
    await h.close();
    await assert.rejects(s.create(key));
    await rm(join(root, key + ".blob"));
    const outside = join(dir, "outside");
    await writeFile(outside, "secret");
    await symlink(outside, join(root, key + ".blob"));
    await assert.rejects(s.read(key));
    await assert.rejects(s.remove(key));
    assert.equal(await readFile(outside, "utf8"), "secret");
    const link = join(dir, "link");
    await symlink(root, link);
    await assert.rejects(localPrivateStorage(link).create("b".repeat(64)));
    assert.throws(() =>
      localPrivateStorage(
        new URL("../../client/public", import.meta.url).pathname,
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
