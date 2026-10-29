import { setTimeout as delay } from "node:timers/promises";
const transient = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "57P03",
  "08006",
]);
// Retry startup connectivity only. Configuration, schema and checksum errors fail immediately.
export async function retryConnection(
  connect,
  { attempts = 5, sleep = delay } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await connect();
    } catch (error) {
      if (!transient.has(error.code) || attempt === attempts - 1) throw error;
      await sleep(Math.min(250 * 2 ** attempt, 2000));
    }
  }
}
