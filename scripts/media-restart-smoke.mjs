import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { postgresAdapter } from "../server/database/adapter.js";
import { migrate } from "../server/database/migrate.js";
import { seedCatalog } from "../server/database/seed.js";
import { mediaQueue } from "../server/media/queue.js";
import { sourceHash, audioPath } from "../server/media/audio.js";
const url = process.env.TEST_DATABASE_URL,
  redisUrl = process.env.TEST_REDIS_URL;
if (!url || !redisUrl)
  throw Error("Set disposable TEST_DATABASE_URL and TEST_REDIS_URL");
const schema = "media_restart_" + randomUUID().replaceAll("-", ""),
  admin = new pg.Pool({ connectionString: url });
await admin.query(`CREATE SCHEMA ${schema}`);
const db = postgresAdapter(url, { schema }),
  prefix = "restart-" + randomUUID(),
  queue = mediaQueue({ redisUrl, redisPrefix: prefix }),
  children = [],
  messages = [];
async function until(fn) {
  for (let n = 0; n < 300; n++) {
    if (await fn()) return;
    await delay(50);
  }
  throw Error("Worker restart verification timed out");
}
function child(mode) {
  const c = spawn(process.execPath, ["scripts/test-media-worker.mjs", mode], {
    env: { ...process.env, TEST_SCHEMA: schema, TEST_QUEUE_PREFIX: prefix },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(c);
  c.stderr.on("data", () => {});
  c.on("message", (m) => messages.push({ pid: c.pid, ...m }));
  return c;
}
try {
  await migrate(db);
  await seedCatalog(db);
  await queue.waitUntilReady();
  const hash = await sourceHash(await audioPath(db, 101));
  const job = await queue.add(
    "analyze-wav",
    { chapterId: 101, hash },
    { jobId: "media-hard-restart" },
  );
  const first = child("hold");
  await until(() =>
    messages.some((m) => m.pid === first.pid && m.type === "active"),
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM chapter_media").get()).n,
    0,
  );
  const dead = once(first, "exit");
  first.kill("SIGKILL");
  await dead;
  console.log(
    "PASS 1: worker killed while its real Redis job was active; no partial metadata committed",
  );
  const second = child("process");
  await until(async () => (await job.getState()) === "completed");
  assert.ok(messages.some((m) => m.type === "stalled"));
  const media = await db
    .prepare("SELECT * FROM chapter_media WHERE chapter_id=101")
    .get();
  assert.equal(media.source_hash, hash);
  assert.equal(JSON.parse(media.waveform).length, 128);
  console.log(
    "PASS 2: replacement worker recovers the stalled BullMQ job and persists actual waveform metadata",
  );
  const duplicate = await queue.add(
    "analyze-wav",
    { chapterId: 101, hash },
    { jobId: "media-idempotent-replay" },
  );
  await until(async () => (await duplicate.getState()) === "completed");
  assert.equal(
    (
      await db
        .prepare("SELECT processed_at FROM chapter_media WHERE chapter_id=101")
        .get()
    ).processed_at,
    media.processed_at,
  );
  console.log(
    "PASS 3: repeated processing preserves one result and its original processing timestamp",
  );
  const closed = once(second, "exit");
  second.kill("SIGTERM");
  await closed;
  console.log("PASS 4: replacement worker drains and shuts down gracefully");
} finally {
  for (const c of children)
    if (c.exitCode === null && c.signalCode === null) {
      const ended = once(c, "exit");
      c.kill("SIGKILL");
      await ended;
    }
  await queue.obliterate({ force: true });
  await queue.close();
  await db.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
