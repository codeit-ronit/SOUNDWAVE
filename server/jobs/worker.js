import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { jobQueue } from "./queue.js";
import { jobHandlers } from "./handlers.js";
export async function runOnce(db, { mail, worker = randomUUID() } = {}) {
  const queue = jobQueue(db),
    job = await queue.claim(worker);
  if (!job) return false;
  try {
    const handler = jobHandlers(db, { mail })[job.kind];
    if (!handler)
      throw Object.assign(Error("Unknown job"), { code: "unknown_job" });
    await queue.perform(job, handler);
  } catch (error) {
    await queue.fail(
      job,
      /^[a-z_0-9]{1,80}$/i.test(error.code || "")
        ? error.code
        : "handler_failed",
    );
  }
  return true;
}
export async function runWorker(db, { mail, signal, onTick } = {}) {
  const worker = randomUUID();
  while (!signal?.aborted) {
    try {
      const bucket = new Date().toISOString().slice(0, 16);
      await jobQueue(db).enqueue("maintenance", {
        key: `maintenance:${bucket}`,
      });
      const worked = await runOnce(db, { mail, worker });
      onTick?.();
      if (!worked) await delay(500, undefined, { signal });
    } catch (error) {
      if (signal?.aborted) break;
      console.error("Worker iteration failed:", error.code || "worker_error");
      await delay(1000, undefined, { signal }).catch(() => {});
    }
  }
}
