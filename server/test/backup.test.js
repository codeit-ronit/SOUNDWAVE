import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { backupDatabase, verifyBackup } from "../operations/backup.js";
if (process.env.TEST_DATABASE_URL && process.env.TEST_BACKUP_CONTAINER) {
  test("real PostgreSQL backup restores all 22 public table fingerprints and never overwrites its archive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soundwave-backup-")),
      path = join(dir, "database.dump"),
      options = { container: process.env.TEST_BACKUP_CONTAINER };
    const client = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      }),
      owner = randomUUID(),
      playlist = randomUUID();
    await client.connect();
    try {
      await client.query(
        "INSERT INTO users(id,display_name,kind,email,password_hash,platform_role) VALUES($1,$2,'registered',$3,'fixture-only-hash','moderator')",
        [owner, "Backup creator fixture", `backup-${owner}@example.com`],
      );
      await client.query(
        "INSERT INTO creator_profiles(user_id,display_name,bio,status) VALUES($1,'Restored creator','Retained private bio','suspended')",
        [owner],
      );
      await client.query(
        "INSERT INTO stories(id,title,genre,author,tagline,description,color,symbol,popularity,ownership_kind,owner_id) VALUES(990001,'Private backup fixture','Test','Owner','','','#abc','radio',0,'creator',$1)",
        [owner],
      );
      await client.query(
        "INSERT INTO playlists(id,user_id,name,next_position) VALUES($1,$2,$3,2)",
        [playlist, owner, "Restored collection"],
      );
      await client.query(
        "INSERT INTO playlist_items(playlist_id,story_id,position) VALUES($1,1,1)",
        [playlist],
      );
      await client.query(
        "INSERT INTO user_preferences(user_id,playback_speed,autoplay_next,default_volume) VALUES($1,1.5,0,0.4)",
        [owner],
      );
      await client.query(
        "INSERT INTO listening_progress(user_id,chapter_id,position_seconds,revision) VALUES($1,101,6,3)",
        [owner],
      );
      await client.query(
        "INSERT INTO progress_write_versions(user_id,chapter_id,client_id,sequence,request_hash,accepted_revision,ack_position,ack_completed,ack_updated_at) VALUES($1,101,$2,9,$3,3,6,0,CURRENT_TIMESTAMP)",
        [owner, randomUUID(), "a".repeat(64)],
      );
      await client.query(
        "INSERT INTO progress_write_versions(user_id,chapter_id,client_id,sequence,request_hash,accepted_revision,ack_position,ack_completed,result_code) VALUES($1,101,$2,10,$3,3,6,0,'PROGRESS_CONFLICT')",
        [owner, randomUUID(), "b".repeat(64)],
      );
      await client.query("UPDATE users SET history_revision=9 WHERE id=$1", [
        owner,
      ]);
      await client.query(
        "INSERT INTO listening_progress(user_id,chapter_id,position_seconds,completed,revision,history_removed) SELECT $1,102,duration_seconds,1,7,1 FROM chapters WHERE id=102",
        [owner],
      );
      const manifest = await backupDatabase(
        process.env.TEST_DATABASE_URL,
        path,
        options,
      );
      assert.equal(Object.keys(manifest.tables).length, 22);
      assert.ok(manifest.tables.user_preferences.count > 0);
      assert.ok(manifest.tables.creator_profiles.count > 0);
      assert.ok(manifest.tables.listening_progress.count > 0);
      assert.ok(manifest.tables.progress_write_versions.count > 0);
      assert.ok(manifest.tables.playlists.count > 0);
      assert.ok(manifest.tables.playlist_items.count > 0);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(path + ".json").mode & 0o777, 0o600);
      assert.deepEqual(
        await verifyBackup(process.env.TEST_DATABASE_URL, path, options),
        { verified: true, tables: 22 },
      );
      // Older version-1 manifests covered the previous 21-table inventory.
      // Verify that allowlisted legacy inventory is accepted, without weakening
      // the full 22-table comparison above or accepting arbitrary table names.
      const manifestPath = path + ".json",
        original = readFileSync(manifestPath, "utf8"),
        legacy = JSON.parse(original);
      delete legacy.tables.creator_profiles;
      writeFileSync(manifestPath, JSON.stringify(legacy));
      assert.deepEqual(
        await verifyBackup(process.env.TEST_DATABASE_URL, path, options),
        { verified: true, tables: 21 },
      );
      legacy.tables.injected = { count: "0", fingerprint: "0" };
      writeFileSync(manifestPath, JSON.stringify(legacy));
      await assert.rejects(
        verifyBackup(process.env.TEST_DATABASE_URL, path, options),
        /Unsupported backup table manifest/,
      );
      writeFileSync(manifestPath, original);
      const size = statSync(path).size;
      await assert.rejects(
        backupDatabase(process.env.TEST_DATABASE_URL, path, options),
        /EEXIST/,
      );
      assert.equal(statSync(path).size, size);
    } finally {
      try {
        await client.query(
          "DELETE FROM progress_write_versions WHERE user_id=$1",
          [owner],
        );
        await client.query("DELETE FROM listening_progress WHERE user_id=$1", [
          owner,
        ]);
        await client.query(
          "DELETE FROM stories WHERE id=990001 AND owner_id=$1",
          [owner],
        );
        await client.query("DELETE FROM users WHERE id=$1", [owner]);
      } finally {
        await client.end();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  test("tampered archives fail integrity verification before any restore database is created", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soundwave-backup-tamper-")),
      path = join(dir, "database.dump"),
      options = { container: process.env.TEST_BACKUP_CONTAINER };
    try {
      await backupDatabase(process.env.TEST_DATABASE_URL, path, options);
      const bytes = readFileSync(path);
      bytes[0] ^= 1;
      writeFileSync(path, bytes);
      await assert.rejects(
        verifyBackup(process.env.TEST_DATABASE_URL, path, options),
        /integrity/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
