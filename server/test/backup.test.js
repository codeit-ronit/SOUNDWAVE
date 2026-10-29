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
import { backupDatabase, verifyBackup } from "../operations/backup.js";
if (process.env.TEST_DATABASE_URL && process.env.TEST_BACKUP_CONTAINER) {
  test("real PostgreSQL backup restores all 13 public table fingerprints and never overwrites its archive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soundwave-backup-")),
      path = join(dir, "database.dump"),
      options = { container: process.env.TEST_BACKUP_CONTAINER };
    try {
      const manifest = await backupDatabase(
        process.env.TEST_DATABASE_URL,
        path,
        options,
      );
      assert.equal(Object.keys(manifest.tables).length, 13);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(path + ".json").mode & 0o777, 0o600);
      assert.deepEqual(
        await verifyBackup(process.env.TEST_DATABASE_URL, path, options),
        { verified: true, tables: 13 },
      );
      const size = statSync(path).size;
      await assert.rejects(
        backupDatabase(process.env.TEST_DATABASE_URL, path, options),
        /EEXIST/,
      );
      assert.equal(statSync(path).size, size);
    } finally {
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
