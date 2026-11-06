import dotenv from "dotenv";
import { connectDatabase } from "../database/index.js";
import { loadConfig } from "../config.js";
import { mediaQueue } from "../media/queue.js";
import { enqueueLibrivoxImports } from "../catalog/import.js";
dotenv.config({ path: new URL("../../.env", import.meta.url), quiet: true });
const config = loadConfig();
if (!config.redisUrl)
  throw Error("REDIS_URL required; run npm run worker to process imports");
const db = await connectDatabase(),
  queue = mediaQueue(config);
try {
  console.log(
    await enqueueLibrivoxImports(db, queue, {
      force: process.argv.includes("--refresh"),
    }),
  );
} finally {
  await queue.close();
  await db.close();
}
