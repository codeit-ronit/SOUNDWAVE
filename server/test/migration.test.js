import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import pg from "pg";
import { openDatabase, seedDatabase } from "../db.js";
import { postgresAdapter } from "../database/adapter.js";
import { migrate } from "../database/migrate.js";
import { seedCatalog } from "../database/seed.js";
import { importSqlite } from "../database/import-sqlite.js";
test("SQLite additive auth migration preserves pre-auth listener rows and keeps a legacy event snapshot", () => {
  const folder = mkdtempSync(join(tmpdir(), "soundwave-legacy-"));
  const path = join(folder, "old.sqlite");
  try {
    // Reconstruct the actual pre-auth schema, not a database already upgraded by openDatabase.
    const old = new Database(path);
    const schema = readFileSync(
      new URL("../db.js", import.meta.url),
      "utf8",
    ).match(/db\.exec\(`([\s\S]*?)`\);/)[1];
    old.exec(schema);
    seedDatabase(old);
    old
      .prepare("INSERT INTO favorites(user_id,story_id) VALUES(?,?)")
      .run("demo-user", 1);
    old
      .prepare(
        "INSERT INTO listening_progress(user_id,chapter_id,position_seconds) VALUES(?,?,?)",
      )
      .run("demo-user", 101, 12);
    old
      .prepare(
        "INSERT INTO listening_events(event_id,user_id,story_id,event_type,listening_seconds) VALUES(?,?,?,?,?)",
      )
      .run(randomUUID(), "demo-user", 1, "story_favorited", 0);
    old.close();
    const db = openDatabase(path);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM favorites").get().n, 1);
    assert.equal(
      db.prepare("SELECT position_seconds FROM listening_progress").get()
        .position_seconds,
      12,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM listening_events").get().n,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM legacy_listening_events_v0").get()
        .n,
      1,
    );
    assert.equal(
      db.prepare("SELECT kind FROM users WHERE id='demo-user'").get().kind,
      "legacy",
    );
    assert.throws(() =>
      db
        .prepare("INSERT INTO favorites(user_id,story_id) VALUES(?,?)")
        .run("missing", 2),
    );
    db.close();
    const again = openDatabase(path);
    assert.equal(
      again.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n,
      6,
    );
    again.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
if (process.env.TEST_DATABASE_URL)
  test("PostgreSQL fresh concurrent migrations and non-destructive repeatable SQLite import", async () => {
    const admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const schema = "import_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db = postgresAdapter(process.env.TEST_DATABASE_URL, { schema });
    const other = postgresAdapter(process.env.TEST_DATABASE_URL, { schema });
    const folder = mkdtempSync(join(tmpdir(), "soundwave-import-"));
    const path = join(folder, "source.sqlite");
    try {
      await Promise.all([migrate(db), migrate(other)]);
      await seedCatalog(db);
      const source = openDatabase(path);
      seedDatabase(source);
      source
        .prepare("INSERT INTO favorites(user_id,story_id) VALUES(?,?)")
        .run("demo-user", 1);
      source
        .prepare(
          "INSERT INTO listening_progress(user_id,chapter_id,position_seconds) VALUES(?,?,?)",
        )
        .run("demo-user", 101, 12.5);
      source.close();
      assert.equal((await importSqlite(db, path)).favorites, 1);
      assert.equal((await importSqlite(db, path)).favorites, 0);
      assert.equal(
        (
          await db
            .prepare(
              "SELECT position_seconds FROM listening_progress WHERE user_id=?",
            )
            .get("demo-user")
        ).position_seconds,
        12.5,
      );
      const check = new Database(path, { readonly: true });
      assert.equal(
        check.prepare("SELECT COUNT(*) AS n FROM favorites").get().n,
        1,
      );
      check.close();
      await assert.rejects(
        db
          .prepare("INSERT INTO favorites(user_id,story_id) VALUES(?,?)")
          .run("missing", 1),
      );
      await assert.rejects(
        db
          .prepare("INSERT INTO favorites(user_id,story_id) VALUES(?,?)")
          .run("demo-user", 99999),
      );
      await db
        .prepare("UPDATE schema_migrations SET checksum=? WHERE version=?")
        .run("tampered", "002_sessions.sql");
      await assert.rejects(migrate(db), /checksum mismatch/);
    } finally {
      await other.close();
      await db.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      rmSync(folder, { recursive: true, force: true });
    }
  });
