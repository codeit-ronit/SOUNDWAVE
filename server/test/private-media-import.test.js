import { processPrivateMedia } from "../media/private-processor.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { setup, reserve } from "./private-media-helpers.js";
import { wav } from "./private-wav-fixture.js";
import { importSqlite } from "../database/import-sqlite.js";
import { password } from "./phase2-helpers.js";
if (process.env.TEST_DATABASE_URL)
  test("PostgreSQL private media import preserves metadata but invalidates unavailable bytes and retained target pointers", async () => {
    const source = await setup("sqlite"),
      target = await setup("postgres");
    try {
      const a = (await reserve(source)).body.asset;
      await source.c
        .write("put", `${source.path}/${a.id}/bytes`, wav())
        .set("Content-Type", "audio/wav")
        .expect(200);
      const intent = await source.db
        .prepare("SELECT * FROM private_processing_intents WHERE asset_id=?")
        .get(a.id);
      await processPrivateMedia(source.db, source.config, intent.id);
      const path = join(source.dir, "source.sqlite");
      await source.db.raw.backup(path);
      // Targets contain unrelated owners; private numeric-ID conflicts are intentionally
      // rejected. Remove only this fixture's own blank draft before importing.
      await target.db
        .prepare("DELETE FROM draft_create_receipts WHERE user_id=?")
        .run(target.c.data.user.id);
      await target.db
        .prepare("DELETE FROM chapters WHERE story_id=?")
        .run(target.s.id);
      await target.db
        .prepare("DELETE FROM stories WHERE id=?")
        .run(target.s.id);
      const counts = await importSqlite(target.db, path);
      assert.equal(counts.private_media_assets, 1);
      assert.equal(counts.private_media_heads, 1);
      assert.equal(counts.private_processing_intents, 1);
      assert.equal(counts.private_media_outputs, 1);
      assert.equal(
        (
          await target.db
            .prepare("SELECT status FROM private_processing_intents WHERE id=?")
            .get(intent.id)
        ).status,
        "failed",
      );
      assert.equal(
        (
          await target.db
            .prepare(
              "SELECT storage_released FROM private_media_outputs WHERE intent_id=?",
            )
            .get(intent.id)
        ).storage_released,
        1,
      );
      const imported = await target.db
        .prepare("SELECT * FROM private_media_assets WHERE id=?")
        .get(a.id);
      assert.equal(imported.status, "failed");
      assert.equal(imported.error_code, "RESTORE_BYTES_REQUIRED");
      assert.equal(imported.storage_released, 1);
      assert.ok(imported.checksum);
      assert.equal(
        (
          await target.db
            .prepare(
              "SELECT asset_id FROM private_media_heads WHERE chapter_id=?",
            )
            .get(source.ch.id)
        ).asset_id,
        null,
      );
      await target.c.auth("logout", {});
      target.c = await target.client();
      const logged = await target.c.auth("login", {
        email: source.c.data.user.email,
        password,
      });
      assert.equal(logged.status, 200);
      const status = (await target.c.get(source.path)).body;
      assert.equal(status.current, null);
      assert.equal(status.usedBytes, 0);
      assert.equal(status.headRevision, 2);
      const b = (
        await target.c.write("post", source.path, {
          requestId: crypto.randomUUID(),
          byteSize: wav().length,
          expectedChapterRevision: 1,
          expectedHeadRevision: status.headRevision,
        })
      ).body.asset;
      await target.c
        .write("put", `${source.path}/${b.id}/bytes`, wav())
        .set("Content-Type", "audio/wav")
        .expect(200);
      await importSqlite(target.db, path);
      assert.equal((await target.c.get(source.path)).body.current.id, b.id);
      await target.c.get(`${source.path}/${a.id}/preview`).expect(404);
    } finally {
      await source.close();
      await target.close();
    }
  });
