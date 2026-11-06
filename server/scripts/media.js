import dotenv from "dotenv";
import { connectDatabase } from "../database/index.js";
import { loadConfig } from "../config.js";
import { mediaQueue, enqueueCatalogMedia } from "../media/queue.js";
dotenv.config({ path: new URL("../../.env", import.meta.url), quiet: true });
const config = loadConfig();
if (!config.redisUrl) throw Error("REDIS_URL required");
const db = await connectDatabase(),
  queue = mediaQueue(config);
try {
  const [action, id] = process.argv.slice(2);
  if (action === "enqueue") console.log(await enqueueCatalogMedia(db, queue));
  else if (action === "list") {
    console.log(
      await queue.getJobCounts(
        "waiting",
        "active",
        "completed",
        "failed",
        "delayed",
      ),
    );
    for (const job of await queue.getJobs(["failed"], 0, 19))
      console.log({
        id: job.id,
        attempts: job.attemptsMade,
        reason: job.failedReason,
      });
  } else if (
    action === "retry" &&
    /^(media|librivox)-[a-zA-Z0-9-]+$/.test(id || "")
  ) {
    const job = await queue.getJob(id);
    if (!job || (await job.getState()) !== "failed")
      throw Error("Failed job not found");
    await job.retry();
    console.log("Retry queued");
  } else throw Error("Usage: npm run media -- enqueue | list | retry JOB_ID");
} finally {
  await queue.close();
  await db.close();
}
