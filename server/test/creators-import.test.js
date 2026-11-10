import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, seedDatabase } from "../db.js";
import { fixture } from "./phase2-helpers.js";
import { importSqlite } from "../database/import-sqlite.js";
if (process.env.TEST_DATABASE_URL)
  test("PostgreSQL creator import preserves identity, role, suspension and ownership; conflicts roll back", async () => {
    const f = await fixture("postgres"),
      dir = mkdtempSync(join(tmpdir(), "soundwave-creator-import-")),
      path = join(dir, "source.sqlite"),
      owner = randomUUID();
    let source;
    try {
      source = openDatabase(path);
      seedDatabase(source);
      source
        .prepare(
          "INSERT INTO users(id,kind,email,password_hash,display_name,platform_role) VALUES(?,'registered',?,'fixture-only','Imported creator','moderator')",
        )
        .run(owner, `${owner}@example.com`);
      source
        .prepare(
          "INSERT INTO creator_profiles(user_id,display_name,bio,status) VALUES(?,'Imported creator','Retained bio','suspended')",
        )
        .run(owner);
      source
        .prepare(
          "INSERT INTO stories(id,title,genre,author,tagline,description,color,symbol,popularity,ownership_kind,owner_id) VALUES(77777,'Private import','Test','Creator','','','#abc','radio',0,'creator',?)",
        )
        .run(owner);
      source
        .prepare(
          "INSERT INTO chapters(id,story_id,chapter_number,title,audio_url,duration_seconds) VALUES(777770,77777,1,'Private chapter','/audio/1-1.wav',35)",
        )
        .run();
      const first = await importSqlite(f.db, path);
      assert.equal(first.creator_profiles, 1);
      assert.equal(
        (
          await f.db
            .prepare("SELECT owner_id FROM stories WHERE id=77777")
            .get()
        ).owner_id,
        owner,
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT platform_role FROM users WHERE id=?")
            .get(owner)
        ).platform_role,
        "moderator",
      );
      source
        .prepare(
          "UPDATE creator_profiles SET status='active',bio='Source changed' WHERE user_id=?",
        )
        .run(owner);
      source
        .prepare("UPDATE users SET platform_role='admin' WHERE id=?")
        .run(owner);
      const second = await importSqlite(f.db, path);
      assert.equal(second.creator_profiles, 0);
      const retained = await f.db
        .prepare("SELECT bio,status FROM creator_profiles WHERE user_id=?")
        .get(owner);
      assert.deepEqual(retained, { bio: "Retained bio", status: "suspended" });
      assert.equal(
        (
          await f.db
            .prepare("SELECT platform_role FROM users WHERE id=?")
            .get(owner)
        ).platform_role,
        "moderator",
      );
      const revision = (
        await f.db
          .prepare("SELECT revision FROM catalog_revision WHERE id=1")
          .get()
      ).revision;
      source
        .prepare(
          "UPDATE stories SET ownership_kind='creator',owner_id=? WHERE id=1",
        )
        .run(owner);
      await assert.rejects(
        importSqlite(f.db, path),
        /Story ownership conflict/,
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT revision FROM catalog_revision WHERE id=1")
            .get()
        ).revision,
        revision,
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT ownership_kind FROM stories WHERE id=1")
            .get()
        ).ownership_kind,
        "system",
      );
      source
        .prepare(
          "UPDATE stories SET ownership_kind='system',owner_id=NULL WHERE id=1",
        )
        .run();
      source
        .prepare(
          "UPDATE chapters SET story_id=77777,chapter_number=99 WHERE id=101",
        )
        .run();
      await assert.rejects(
        importSqlite(f.db, path),
        /Chapter ownership conflict/,
      );
      assert.equal(
        (await f.db.prepare("SELECT story_id FROM chapters WHERE id=101").get())
          .story_id,
        1,
      );
    } finally {
      source?.close();
      await f.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
