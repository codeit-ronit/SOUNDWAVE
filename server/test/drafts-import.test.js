import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openDatabase, seedDatabase } from "../db.js";
import { sqliteAdapter } from "../database/adapter.js";
import { draftService } from "../services/drafts.js";
import { importSqlite } from "../database/import-sqlite.js";
import { fixture } from "./phase2-helpers.js";
if (process.env.TEST_DATABASE_URL)
  test("PostgreSQL draft import preserves receipts, tombstones and ID high-water marks without overwriting retained collections", async () => {
    const f = await fixture("postgres"),
      dir = mkdtempSync(join(tmpdir(), "soundwave-draft-import-")),
      path = join(dir, "source.sqlite"),
      owner = randomUUID(),
      principal = { id: owner };
    let raw;
    try {
      raw = openDatabase(path);
      seedDatabase(raw);
      const source = sqliteAdapter(raw),
        svc = draftService(source);
      raw
        .prepare(
          "INSERT INTO users(id,email,password_hash,display_name,kind) VALUES(?,?,'fixture-only','Imported creator','registered')",
        )
        .run(owner, `${owner}@example.com`);
      raw
        .prepare(
          "INSERT INTO creator_profiles(user_id,display_name) VALUES(?,'Creator')",
        )
        .run(owner);
      const key = randomUUID(),
        metadata = {
          title: "Imported draft",
          description: "Preserved",
          genre: "Test",
          language: "hi",
        };
      let data = await svc.create(principal, metadata, key);
      data = await svc.addChapter(
        principal,
        data.story.id,
        { title: "One", summary: "Retained" },
        randomUUID(),
        data.story.revision,
      );
      data = await svc.addChapter(
        principal,
        data.story.id,
        { title: "Two", summary: "Removed" },
        randomUUID(),
        data.story.revision,
      );
      data = await svc.removeChapter(
        principal,
        data.story.id,
        data.chapters[1].id,
        data.chapters[1].revision,
        data.story.revision,
      );
      data = await svc.archive(principal, data.story.id, data.story.revision);
      raw
        .prepare(
          "UPDATE creator_id_allocations SET next_id=900000100 WHERE kind='story'",
        )
        .run();
      const first = await importSqlite(f.db, path);
      assert.equal(first.draft_create_receipts, 3);
      const target = draftService(f.db);
      assert.deepEqual(await target.read(principal, data.story.id), {
        story: data.story,
        chapters: data.chapters,
      });
      const replay = await target.create(principal, metadata, key);
      assert.equal(replay.replayed, true);
      assert.equal(replay.story.state, "archived");
      const next = await target.create(
        principal,
        { ...metadata, title: "After import" },
        randomUUID(),
      );
      assert.equal(next.story.id, 900000100);
      raw
        .prepare(
          "UPDATE stories SET draft_state='draft',draft_revision=1,description='Stale source' WHERE id=?",
        )
        .run(data.story.id);
      const extra = await svc.addChapter(
        principal,
        data.story.id,
        { title: "Must not attach to retained parent", summary: "" },
        randomUUID(),
        1,
      );
      const again = await importSqlite(f.db, path);
      assert.equal(again.draft_create_receipts, 0);
      assert.equal(
        (await target.read(principal, data.story.id)).story.state,
        "archived",
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT COUNT(*) AS n FROM chapters WHERE id=?")
            .get(extra.chapter.id)
        ).n,
        0,
      );
      assert.ok(
        (
          await f.db
            .prepare(
              "SELECT next_id FROM creator_id_allocations WHERE kind='chapter'",
            )
            .get()
        ).next_id > extra.chapter.id,
      );
      const rev = (
        await f.db
          .prepare("SELECT revision FROM catalog_revision WHERE id=1")
          .get()
      ).revision;
      raw
        .prepare(
          "UPDATE draft_create_receipts SET request_hash=? WHERE request_id=?",
        )
        .run("d".repeat(64), key);
      await assert.rejects(
        importSqlite(f.db, path),
        /Draft receipt identity conflict/,
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT revision FROM catalog_revision WHERE id=1")
            .get()
        ).revision,
        rev,
      );
      assert.equal(
        (await target.create(principal, metadata, key)).story.state,
        "archived",
      );
    } finally {
      raw?.close();
      await f.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
