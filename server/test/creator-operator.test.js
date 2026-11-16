import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { openDatabase, seedDatabase } from "../db.js";
test("operator CLI requires explicit confirmation, validates before connecting and provisions only the selected disposable database", () => {
  const folder = mkdtempSync(join(tmpdir(), "soundwave-creator-operator-")),
    path = join(folder, "fixture.sqlite"),
    id = randomUUID();
  let db;
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "test",
    DATABASE_DRIVER: "sqlite",
    DATABASE_PATH: path,
    EMAIL_MODE: "disabled",
  };
  const run = (...args) =>
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/creator.js", import.meta.url)),
        ...args,
      ],
      {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  try {
    db = openDatabase(path);
    seedDatabase(db);
    db.prepare(
      "INSERT INTO users(id,email,password_hash,display_name,kind) VALUES(?,?,'fixture-only','Operator fixture','registered')",
    ).run(id, `${id}@example.com`);
    db.prepare(
      "INSERT INTO creator_profiles(user_id,display_name,bio) VALUES(?,'Creator','Retained bio')",
    ).run(id);
    db.prepare(
      "UPDATE stories SET owner_id=?,ownership_kind='creator',title='Retained owner story' WHERE id=1",
    ).run(id);
    db.close();
    db = null;
    assert.throws(
      () => run("role", id, "admin"),
      (e) => e.status !== 0 && String(e.stderr).includes("confirm-operator"),
    );
    assert.throws(
      () => run("role", id, "superuser", "--confirm-operator"),
      (e) =>
        e.status !== 0 && String(e.stderr).includes("Invalid operator action"),
    );
    assert.match(
      run("role", id, "moderator", "--confirm-operator"),
      /moderator/,
    );
    assert.match(
      run("status", id, "suspended", "--confirm-operator"),
      /suspended/,
    );
    db = openDatabase(path);
    assert.equal(
      db.prepare("SELECT platform_role FROM users WHERE id=?").get(id)
        .platform_role,
      "moderator",
    );
    assert.equal(
      db.prepare("SELECT status FROM creator_profiles WHERE user_id=?").get(id)
        .status,
      "suspended",
    );
    assert.equal(
      db.prepare("SELECT title FROM stories WHERE id=1").get().title,
      "Retained owner story",
    );
  } finally {
    db?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
