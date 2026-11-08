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
import { playlistService } from "../services/playlists.js";
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
      13,
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
      const receiptClient = randomUUID();
      source
        .prepare(
          "UPDATE listening_progress SET revision=4 WHERE user_id='demo-user' AND chapter_id=101",
        )
        .run();
      source
        .prepare(
          "INSERT INTO progress_write_versions(user_id,chapter_id,client_id,sequence,request_hash,accepted_revision,ack_position,ack_completed,ack_updated_at) VALUES('demo-user',101,?,8,?,4,12.5,0,?)",
        )
        .run(receiptClient, "a".repeat(64), new Date().toISOString());
      const playlistId = randomUUID();
      source
        .prepare(
          "INSERT INTO playlists(id,user_id,name,next_position) VALUES(?,?,?,?)",
        )
        .run(playlistId, "demo-user", "Imported playlist", 2);
      source
        .prepare(
          "INSERT INTO playlist_items(playlist_id,story_id,position) VALUES(?,?,?)",
        )
        .run(playlistId, 2, 1);
      const mergedId = randomUUID();
      source
        .prepare(
          "INSERT INTO playlists(id,user_id,name,next_position) VALUES(?,?,?,?)",
        )
        .run(mergedId, "demo-user", "Source collection", 4);
      source
        .prepare(
          "INSERT INTO playlist_items(playlist_id,story_id,position) VALUES(?,?,?)",
        )
        .run(mergedId, 2, 3);
      await db
        .prepare("INSERT INTO playlists(id,user_id,name) VALUES(?,?,?)")
        .run(mergedId, "demo-user", "Existing collection");
      const rejectedClient = randomUUID();
      source
        .prepare(
          "INSERT INTO progress_write_versions(user_id,chapter_id,client_id,sequence,request_hash,accepted_revision,ack_position,result_code) VALUES('demo-user',101,?,9,?,4,12.5,'PROGRESS_CONFLICT')",
        )
        .run(rejectedClient, "b".repeat(64));
      source.close();
      const settingsSource = new Database(path);
      settingsSource
        .prepare(
          "INSERT INTO user_preferences(user_id,playback_speed,autoplay_next,default_volume) VALUES(?,?,?,?)",
        )
        .run("demo-user", 1.5, 0, 0.4);
      settingsSource.close();
      const imported = await importSqlite(db, path);
      assert.equal(imported.user_preferences, 1);
      assert.equal(imported.progress_write_versions, 2);
      assert.equal(
        (
          await db
            .prepare(
              "SELECT result_code FROM progress_write_versions WHERE client_id=?",
            )
            .get(rejectedClient)
        ).result_code,
        "PROGRESS_CONFLICT",
      );
      assert.equal(
        (
          await db
            .prepare(
              "SELECT revision FROM listening_progress WHERE user_id='demo-user'",
            )
            .get()
        ).revision,
        4,
      );
      assert.equal(
        (
          await db
            .prepare(
              "SELECT accepted_revision FROM progress_write_versions WHERE user_id='demo-user'",
            )
            .get()
        ).accepted_revision,
        4,
      );
      await db
        .prepare(
          "UPDATE listening_progress SET revision=6 WHERE user_id='demo-user'",
        )
        .run();
      assert.equal(
        (
          await db
            .prepare(
              "SELECT playback_speed FROM user_preferences WHERE user_id=?",
            )
            .get("demo-user")
        ).playback_speed,
        1.5,
      );
      await db
        .prepare("UPDATE user_preferences SET playback_speed=2 WHERE user_id=?")
        .run("demo-user");
      assert.equal(imported.favorites, 1);
      assert.equal(imported.playlists, 1);
      assert.equal(imported.playlist_items, 2);
      const repeated = await importSqlite(db, path);
      assert.equal(repeated.favorites, 0);
      assert.equal(repeated.progress_write_versions, 0);
      assert.equal(
        (
          await db
            .prepare(
              "SELECT revision FROM listening_progress WHERE user_id='demo-user'",
            )
            .get()
        ).revision,
        6,
      );
      assert.equal(repeated.playlists, 0);
      assert.equal(repeated.playlist_items, 0);
      assert.equal(repeated.user_preferences, 0);
      assert.equal(
        (
          await db
            .prepare(
              "SELECT playback_speed FROM user_preferences WHERE user_id=?",
            )
            .get("demo-user")
        ).playback_speed,
        2,
      );
      await playlistService(db).add("demo-user", mergedId, 1);
      assert.equal(
        (
          await db
            .prepare(
              "SELECT position FROM playlist_items WHERE playlist_id=? AND story_id=1",
            )
            .get(mergedId)
        ).position,
        4,
      );
      assert.equal(
        (
          await db
            .prepare("SELECT name FROM playlists WHERE id=?")
            .get(mergedId)
        ).name,
        "Existing collection",
      );
      assert.equal(
        (
          await db
            .prepare("SELECT story_id FROM playlist_items WHERE playlist_id=?")
            .get(playlistId)
        ).story_id,
        2,
      );
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
      const collision = randomUUID(),
        foreignUser = randomUUID();
      await db
        .prepare("INSERT INTO users(id,display_name,kind) VALUES(?,?,?)")
        .run(foreignUser, "Another owner", "guest");
      await db
        .prepare("INSERT INTO playlists(id,user_id,name) VALUES(?,?,?)")
        .run(collision, foreignUser, "Existing owner");
      const edited = new Database(path);
      edited
        .prepare(
          "INSERT INTO playlists(id,user_id,name,next_position) VALUES(?,?,?,?)",
        )
        .run(collision, "demo-user", "Conflicting import", 2);
      edited
        .prepare(
          "INSERT INTO playlist_items(playlist_id,story_id,position) VALUES(?,?,?)",
        )
        .run(collision, 1, 1);
      edited.close();
      await assert.rejects(
        importSqlite(db, path),
        /Playlist ownership conflict/,
      );
      assert.equal(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id=?",
            )
            .get(collision)
        ).n,
        0,
      );
      const overfull = randomUUID(),
        oversizedSource = new Database(path);
      oversizedSource
        .prepare("DELETE FROM playlist_items WHERE playlist_id=?")
        .run(collision);
      oversizedSource
        .prepare("DELETE FROM playlists WHERE id=?")
        .run(collision);
      oversizedSource
        .prepare(
          "INSERT INTO playlists(id,user_id,name,next_position) VALUES(?,?,?,?)",
        )
        .run(overfull, "demo-user", "Invalid oversized fixture", 102);
      for (let i = 0; i < 101; i++) {
        oversizedSource
          .prepare(
            "INSERT INTO stories(id,title,genre,author,tagline,description,color,symbol,popularity) SELECT ?,title,genre,author,tagline,description,color,symbol,popularity FROM stories WHERE id=1",
          )
          .run(10000 + i);
        oversizedSource
          .prepare(
            "INSERT INTO playlist_items(playlist_id,story_id,position) VALUES(?,?,?)",
          )
          .run(overfull, 10000 + i, i + 1);
      }
      oversizedSource.close();
      await assert.rejects(
        importSqlite(db, path),
        /Playlist import exceeds membership\/order limits/,
      );
      assert.equal(
        await db.prepare("SELECT id FROM playlists WHERE id=?").get(overfull),
        undefined,
      );
      assert.equal(
        await db.prepare("SELECT id FROM stories WHERE id=10000").get(),
        undefined,
      );
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
