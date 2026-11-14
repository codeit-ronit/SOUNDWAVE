import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, cp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import request from "supertest";
import { publicationFixture } from "../server/test/publishing-helpers.js";
import { postgresAdapter } from "../server/database/adapter.js";
import { createApp } from "../server/app.js";
import { localPrivateStorage } from "../server/storage/local-private.js";
import {
  exportTakedowns,
  reconcileTakedowns,
} from "../server/operations/takedowns.js";
const url = process.env.TEST_DATABASE_URL,
  container = process.env.TEST_BACKUP_CONTAINER;
if (
  !url ||
  !container ||
  !/^[a-zA-Z0-9_-]+$/.test(container) ||
  !["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
  !new URL(url).pathname.startsWith("/soundwave_ci_")
)
  throw Error(
    "Explicit disposable loopback CI database and backup container required",
  );
const f = await publicationFixture("postgres"),
  admin = new pg.Pool({ connectionString: url }),
  name = "soundwave_ci_restore_" + randomUUID().replaceAll("-", ""),
  dir = await mkdtemp(join(tmpdir(), "soundwave-restore-")),
  result = { at: new Date().toISOString(), checks: [] };
let restored,
  created = false;
const pass = (s) => {
  result.checks.push(s);
  console.log(`PASS ${result.checks.length}: ${s}`);
};
try {
  await f.submit();
  await f.approve();
  await f.publish();
  const schema = (await f.db.prepare("SELECT current_schema() AS name").get())
    .name;
  const dump = execFileSync(
    "docker",
    [
      "exec",
      container,
      "pg_dump",
      "-U",
      new URL(url).username,
      "-d",
      new URL(url).pathname.slice(1),
      "--schema",
      schema,
      "-Fc",
    ],
    { maxBuffer: 16777216, timeout: 30000 },
  );
  await writeFile(join(dir, "archive.dump"), dump, { mode: 0o600, flag: "wx" });
  await cp(f.config.privateMediaRoot, join(dir, "media"), {
    recursive: true,
    preserveTimestamps: true,
  });
  result.archiveSha256 = createHash("sha256").update(dump).digest("hex");
  pass(
    "drained fixture snapshot contains a genuine PostgreSQL archive and matching private source/MP3 directory",
  );
  await f.action(f.moderator, f.review, "revoke", {
    code: "rights_concern",
    note: "Takedown after backup",
  });
  const ledger = await exportTakedowns(f.db);
  assert.equal(ledger.entries.length, 1);
  await admin.query(`CREATE DATABASE ${name}`);
  created = true;
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "pg_restore",
      "-U",
      new URL(url).username,
      "-d",
      name,
      "--exit-on-error",
      "--no-owner",
    ],
    { input: dump, maxBuffer: 1048576, timeout: 30000 },
  );
  const target = new URL(url);
  target.pathname = "/" + name;
  restored = postgresAdapter(target.toString(), { schema });
  const config = {
      ...f.config,
      privateMediaRoot: join(dir, "media"),
      releaseQuarantined: true,
    },
    quarantine = createApp(restored, { config });
  await request(quarantine).get(`/api/chapters/${f.ch.id}/stream`).expect(503);
  await request(quarantine).get("/api/ready").expect(503);
  await request(quarantine).get("/audio/1-1.wav").expect(503);
  pass(
    "restored service is quarantined: public APIs, legacy streams and readiness are blocked before operator verification",
  );
  const storage = localPrivateStorage(config.privateMediaRoot),
    objects = [
      ...(await restored
        .prepare(
          "SELECT object_key,checksum,byte_size FROM private_media_assets WHERE status='validated'",
        )
        .all()),
      ...(await restored
        .prepare(
          "SELECT object_key,checksum,byte_size FROM private_media_outputs WHERE status='ready'",
        )
        .all()),
    ];
  for (const o of objects) {
    const h = await storage.read(o.object_key);
    try {
      assert.equal((await h.stat()).size, o.byte_size);
      const digest = createHash("sha256");
      for await (const chunk of h.createReadStream({ autoClose: false }))
        digest.update(chunk);
      assert.equal(digest.digest("hex"), o.checksum);
    } finally {
      await h.close();
    }
  }
  assert.equal(objects.length, 2);
  pass(
    "matching restored WAV and MP3 bytes pass full size/SHA-256 checks against restored metadata",
  );
  assert.equal(
    (
      await restored
        .prepare("SELECT state FROM story_publications WHERE story_id=?")
        .get(f.s.id)
    ).state,
    "published",
  );
  assert.deepEqual(await reconcileTakedowns(restored, ledger), { changed: 1 });
  assert.deepEqual(await reconcileTakedowns(restored, ledger), { changed: 0 });
  const opened = createApp(restored, {
    config: { ...config, releaseQuarantined: false },
  });
  await request(opened).get(`/api/stories/${f.s.id}`).expect(404);
  await request(opened)
    .get(`/api/chapters/${f.ch.id}/stream`)
    .set("Range", "bytes=0-11")
    .expect(404);
  assert.equal(
    (
      await restored
        .prepare(
          "SELECT COUNT(*) AS n FROM publication_audit WHERE decision_code='restore_takedown'",
        )
        .get()
    ).n,
    1,
  );
  pass(
    "later takedown ledger advances restored revision once; repeat-safe reconciliation blocks public catalog/ranges after controlled reopening",
  );
  const missing = {
    ...ledger,
    entries: [{ id: f.s.id, revision: ledger.entries[0].revision + 10 }],
  };
  assert.deepEqual(await reconcileTakedowns(restored, missing), { changed: 1 });
  assert.ok(
    (
      await restored
        .prepare("SELECT revision FROM story_publications WHERE story_id=?")
        .get(f.s.id)
    ).revision > missing.entries[0].revision,
  );
  pass(
    "higher external revocation high-water marks cannot be bypassed by an older restored revision",
  );
  writeFileSync(
    process.argv[2] || "docs/m3-m4-recovery.json",
    JSON.stringify(result, null, 2) + "\n",
  );
} finally {
  await restored?.close();
  if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
  await f.close();
  await rm(dir, { recursive: true, force: true });
}
