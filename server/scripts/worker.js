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
console.log("SoundWave worker started");
try {
  await runWorker(db, { mail, signal: controller.signal });
} finally {
  mail?.close();
  await db.close();
}
