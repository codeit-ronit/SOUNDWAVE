import { Queue, Worker, UnrecoverableError } from "bullmq";
import { setTimeout as delay } from "node:timers/promises";
import {
  audioPath,
  sourceHash,
  processChapterMedia,
  PROCESSOR_VERSION,
} from "./audio.js";
export function queueOptions(url, prefix, { worker = false } = {}) {
  if (!/^[a-zA-Z0-9:_-]{1,80}$/.test(prefix))
    throw Error("Invalid Redis prefix");
  const u = new URL(url);
  if (!["redis:", "rediss:"].includes(u.protocol))
    throw Error("Redis URL required");
  return {
    prefix: prefix + ":bullmq",
    connection: {
      host: u.hostname,
      port: Number(u.port || 6379),
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      db: Number(u.pathname.slice(1) || 0),
      ...(u.protocol === "rediss:"
        ? { tls: { rejectUnauthorized: true } }
        : {}),
      maxRetriesPerRequest: worker ? null : 1,
      enableOfflineQueue: worker,
      connectTimeout: 1000,
      retryStrategy: (n) => Math.min(n * 100, 2000),
    },
  };
}
export function mediaQueue(config) {
  const queue = new Queue("soundwave-media", {
    ...queueOptions(config.redisUrl, config.redisPrefix),
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { age: 7 * 86400, count: 1000 },
      removeOnFail: { age: 30 * 86400, count: 1000 },
    },
  });
  queue.on("error", () => {});
  return queue;
}
export async function enqueueCatalogMedia(db, queue) {
  let enqueued = 0,
    skipped = 0;
  for (const { id } of await db
    .prepare("SELECT id FROM chapters ORDER BY id")
    .all()) {
    const hash = await sourceHash(await audioPath(db, id));
    const current = await db
      .prepare(
        "SELECT source_hash,processor_version FROM chapter_media WHERE chapter_id=?",
      )
      .get(id);
    if (
      current?.source_hash === hash &&
      current.processor_version === PROCESSOR_VERSION
    ) {
      skipped++;
      continue;
    }
    await queue.add(
      "analyze-wav",
      { chapterId: id, hash },
      { jobId: `media-${id}-v${PROCESSOR_VERSION}-${hash}` },
    );
    enqueued++;
  }
  return { enqueued, skipped };
}
export function startMediaWorker(
  db,
  config,
  { processor, workerOptions = {} } = {},
) {
  const worker = new Worker(
    "soundwave-media",
    processor ||
      (async (job) => {
        try {
          return await processChapterMedia(db, job.data);
        } catch (error) {
          if (error.code === "INVALID_MEDIA" || error.code === "ENOENT")
            throw new UnrecoverableError("unsupported_or_missing_media");
          throw Error("media_processing_failed");
        }
      }),
    {
      ...queueOptions(config.redisUrl, config.redisPrefix, { worker: true }),
      concurrency: 2,
      lockDuration: 30000,
      stalledInterval: 30000,
      maxStalledCount: 2,
      ...workerOptions,
    },
  );
  worker.on("error", () => {});
  worker.on("failed", (job) => console.error("Media job failed:", job?.id));
  return worker;
}
export async function runMediaScheduler(db, queue, signal) {
  while (!signal.aborted) {
    try {
      await enqueueCatalogMedia(db, queue);
    } catch {
      console.error("Media scheduling unavailable; will retry");
    }
    await delay(60000, undefined, { signal }).catch(() => {});
  }
}
