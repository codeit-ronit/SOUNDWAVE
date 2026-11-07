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
  test("real PostgreSQL backup restores all 21 public table fingerprints and never overwrites its archive", async () => {
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
        "INSERT INTO users(id,display_name,kind) VALUES($1,$2,$3)",
        [owner, "Backup playlist fixture", "guest"],
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
      const manifest = await backupDatabase(
        process.env.TEST_DATABASE_URL,
        path,
        options,
      );
      assert.equal(Object.keys(manifest.tables).length, 21);
      assert.ok(manifest.tables.user_preferences.count > 0);
      assert.ok(manifest.tables.playlists.count > 0);
      assert.ok(manifest.tables.playlist_items.count > 0);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(path + ".json").mode & 0o777, 0o600);
      assert.deepEqual(
        await verifyBackup(process.env.TEST_DATABASE_URL, path, options),
        { verified: true, tables: 21 },
      );
      const size = statSync(path).size;
      await assert.rejects(
        backupDatabase(process.env.TEST_DATABASE_URL, path, options),
        /EEXIST/,
      );
      assert.equal(statSync(path).size, size);
    } finally {
      await client.query("DELETE FROM users WHERE id=$1", [owner]);
      await client.end();
      rmSync(dir, { recursive: true, force: true });
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
