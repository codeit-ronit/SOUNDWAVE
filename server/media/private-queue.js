import { createHash } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { setTimeout as delay } from "node:timers/promises";
import { queueOptions } from "./queue.js";
import { processPrivateMedia } from "./private-processor.js";
import { processingIntents } from "../services/processing-intents.js";
import { localPrivateStorage } from "../storage/local-private.js";
export const transportId = (p) =>
  createHash("sha256").update(`${p.job_key}:${p.generation}`).digest("hex");
export function privateProcessingQueue(config) {
  const q = new Queue("soundwave-private-audio", {
    ...queueOptions(config.redisUrl, config.redisPrefix),
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 86400, count: 1000 },
    },
  });
  q.on("error", () => {});
  return q;
}
export async function dispatchProcessingIntent(db, queue, id) {
  const p = await db
    .prepare("SELECT * FROM private_processing_intents WHERE id=?")
    .get(id);
  if (!p || !["pending", "processing"].includes(p.status)) return;
  const jobId = transportId(p),
    existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (["failed", "completed"].includes(state)) await existing.remove();
    else return;
  }
  await queue.add("private-audio", { intentId: p.id }, { jobId });
}
export function startPrivateProcessingWorker(
  db,
  config,
  { signal, processor = processPrivateMedia, ...options } = {},
) {
  const worker = new Worker(
    "soundwave-private-audio",
    (job) => processor(db, config, job.data.intentId, { signal }),
    {
      ...queueOptions(config.redisUrl, config.redisPrefix, { worker: true }),
      concurrency: 1,
      lockDuration: 30000,
      stalledInterval: 10000,
      maxStalledCount: 2,
      ...options,
    },
  );
  worker.on("error", () => {});
  worker.on("failed", () =>
    console.error("Private audio job failed; inspect owned processing status"),
  );
  return worker;
}
export async function runPrivateProcessingRecovery(db, config, signal) {
  const service = processingIntents(
    db,
    config,
    localPrivateStorage(config.privateMediaRoot),
  );
  while (!signal.aborted) {
    try {
      await service.reconcile();
      await service.sweep();
    } catch (e) {
      console.error(
        "Private processing recovery unavailable",
        e.code || "recovery_error",
      );
    }
    await delay(5000, undefined, { signal }).catch(() => {});
  }
}
