// Test-only child process for proving BullMQ recovery from a hard worker crash.
import { postgresAdapter } from "../server/database/adapter.js";
import { startMediaWorker } from "../server/media/queue.js";
const db = postgresAdapter(process.env.TEST_DATABASE_URL, {
  schema: process.env.TEST_SCHEMA,
});
const config = {
  redisUrl: process.env.TEST_REDIS_URL,
  redisPrefix: process.env.TEST_QUEUE_PREFIX,
};
const worker = startMediaWorker(db, config, {
  ...(process.argv[2] === "hold"
    ? {
        processor: async () => {
          process.send?.({ type: "active" });
          await new Promise(() => {});
        },
      }
    : {}),
  workerOptions: { concurrency: 1, lockDuration: 1000, stalledInterval: 1000 },
});
worker.on("ready", () => process.send?.({ type: "ready" }));
worker.on("stalled", () => process.send?.({ type: "stalled" }));
worker.on("completed", () => process.send?.({ type: "completed" }));
process.once("SIGTERM", async () => {
  await worker.close();
  await db.close();
  process.disconnect?.();
});
