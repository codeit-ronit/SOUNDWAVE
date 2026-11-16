import { telemetry } from "../telemetry.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { jobQueue } from "./queue.js";
import { jobHandlers } from "./handlers.js";
export async function runOnce(
  db,
  { mail, privateQueue, worker = randomUUID() } = {},
) {
  const queue = jobQueue(db),
    job = await queue.claim(worker, 30000, new Date(), !privateQueue);
  if (!job) return false;
  const started = performance.now();
  try {
    const handler = jobHandlers(db, { mail, privateQueue })[job.kind];
    if (!handler)
      throw Object.assign(Error("Unknown job"), { code: "unknown_job" });
    await queue.perform(job, handler);
  } catch (error) {
    telemetry(db).observe("job_failures", "outbox");
    await queue.fail(
      job,
      /^[a-z_0-9]{1,80}$/i.test(error.code || "")
        ? error.code
        : "handler_failed",
    );
  }
  telemetry(db).observe(
    "job_ms",
    ["maintenance", "analytics_rollup", "send_email"].includes(job.kind)
      ? job.kind
      : "other",
    performance.now() - started,
  );
  return true;
}
export async function runWorker(
  db,
  { mail, privateQueue, signal, onTick } = {},
) {
  const worker = randomUUID();
  while (!signal?.aborted) {
    try {
      const bucket = new Date().toISOString().slice(0, 16);
      await jobQueue(db).enqueue("maintenance", {
        key: `maintenance:${bucket}`,
      });
      const worked = await runOnce(db, { mail, privateQueue, worker });
      onTick?.();
      if (!worked) await delay(500, undefined, { signal });
    } catch (error) {
      if (signal?.aborted) break;
      console.error("Worker iteration failed:", error.code || "worker_error");
      await delay(1000, undefined, { signal }).catch(() => {});
    }
  }
}
