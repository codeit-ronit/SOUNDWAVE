import { setTimeout as delay } from "node:timers/promises";
import { privateMediaService } from "../services/private-media.js";
export async function runPrivateMediaCleanup(db, config, signal) {
  const service = privateMediaService(db, config);
  while (!signal.aborted) {
    try {
      await service.sweep();
    } catch (error) {
      console.error(
        "Private media cleanup failed:",
        error.code || "cleanup_error",
      );
    }
    await delay(30000, undefined, { signal }).catch(() => {});
  }
}
