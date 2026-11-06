import { redisInfrastructure } from "../infrastructure/redis.js";
import { writeFileSync, unlinkSync } from "node:fs";
import {
  mediaQueue,
  startMediaWorker,
  runMediaScheduler,
} from "../media/queue.js";
import dotenv from "dotenv";
import { loadConfig } from "../config.js";
import { connectDatabase } from "../database/index.js";
import { retryConnection } from "../database/retry.js";
import { runWorker } from "../jobs/worker.js";
import { emailTransport } from "../services/mail.js";
dotenv.config({ path: new URL("../../.env", import.meta.url), quiet: true });
const config = loadConfig(),
  db = await retryConnection(() => connectDatabase()),
  mail = emailTransport(config),
  controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => controller.abort());
const media =
  config.redisUrl && config.mediaEnabled
    ? { queue: mediaQueue(config), worker: startMediaWorker(db, config) }
    : null;
const healthRedis = media
  ? redisInfrastructure(config.redisUrl, { prefix: config.redisPrefix })
  : null;
healthRedis?.start();
const healthFile =
  process.env.WORKER_HEALTH_FILE || "/tmp/soundwave-worker-health.json";
const tick = () =>
  writeFileSync(
    healthFile,
    JSON.stringify({
      pid: process.pid,
      at: Date.now(),
      mediaEnabled: !!media,
      mediaReady: !media || (healthRedis.ready() && media.worker.isRunning()),
    }),
    { mode: 0o600 },
  );
tick();
console.log("SoundWave worker started");
try {
  await Promise.all([
    runWorker(db, { mail, signal: controller.signal, onTick: tick }),
    ...(media
      ? [
          runMediaScheduler(db, media.queue, controller.signal, {
            catalogEnabled: config.catalogImportEnabled,
          }),
        ]
      : []),
  ]);
} finally {
  if (media) {
    await media.worker.close();
    await media.queue.close();
  }
  try {
    unlinkSync(healthFile);
  } catch {}
  await healthRedis?.close();
  mail?.close();
  await db.close();
}
