// Test-only worker entrypoint. Production processing implementation, IPC checkpoints.
import { openDatabase } from "../db.js";
import { sqliteAdapter, postgresAdapter } from "../database/adapter.js";
import { loadConfig } from "../config.js";
import { processPrivateMedia } from "../media/private-processor.js";
const db = process.env.PROCESSING_TEST_SCHEMA
  ? postgresAdapter(process.env.TEST_DATABASE_URL, {
      schema: process.env.PROCESSING_TEST_SCHEMA,
    })
  : sqliteAdapter(openDatabase(process.env.PROCESSING_TEST_SQLITE));
const checkpoint = async (phase) => {
  process.send?.({ phase });
  if (process.env.PROCESSING_TEST_PAUSE === phase)
    await new Promise((resolve) => process.once("message", resolve));
};
try {
  await processPrivateMedia(
    db,
    loadConfig(process.env),
    process.env.PROCESSING_TEST_INTENT,
    {
      hooks: {
        afterClaim: () => checkpoint("claimed"),
        onOutput: () => checkpoint("transcoding"),
        afterOutput: () => checkpoint("written"),
        afterCommit: () => checkpoint("committed"),
      },
    },
  );
  await checkpoint("done");
} finally {
  await db.close();
  process.disconnect?.();
}
