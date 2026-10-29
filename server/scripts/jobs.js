import { backfillRollups } from "../jobs/backfill.js";
import dotenv from "dotenv";
import { connectDatabase } from "../database/index.js";
import { jobQueue } from "../jobs/queue.js";
dotenv.config({ path: new URL("../../.env", import.meta.url), quiet: true });
const db = await connectDatabase();
try {
  const [action, id] = process.argv.slice(2);
  if (action === "list")
    console.log(
      await db
        .prepare(
          "SELECT id,kind,status,attempts,max_attempts,last_error,created_at FROM background_jobs WHERE status IN ('dead','pending','running') ORDER BY created_at LIMIT 50",
        )
        .all(),
    );
  else if (action === "retry" && /^[a-f0-9-]{36}$/.test(id || ""))
    console.log(
      await db
        .prepare(
          "UPDATE background_jobs SET status='pending',attempts=0,available_at=?,last_error=NULL WHERE id=? AND status='dead' AND kind<>'send_email'",
        )
        .run(new Date().toISOString(), id),
    );
  else if (action === "backfill")
    console.log({ enqueued: await backfillRollups(db) });
  else if (action === "maintenance")
    console.log({ jobId: await jobQueue(db).enqueue("maintenance") });
  else
    throw Error(
      "Usage: npm run jobs -- list | backfill | maintenance | retry JOB_UUID (request fresh links instead of retrying dead email)",
    );
} finally {
  await db.close();
}
