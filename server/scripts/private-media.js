import { processingIntents } from "../services/processing-intents.js";
import { connectDatabase } from "../database/index.js";
import { loadConfig } from "../config.js";
import { privateMediaService } from "../services/private-media.js";
import { createHash } from "node:crypto";
const [action, confirmation, ...extra] = process.argv.slice(2);
if (
  !["verify", "cleanup"].includes(action) ||
  confirmation !== "--confirm-operator" ||
  extra.length ||
  (!process.env.DATABASE_URL &&
    !(process.env.DATABASE_DRIVER === "sqlite" && process.env.DATABASE_PATH))
)
  throw Error(
    "Set an explicit database and PRIVATE_MEDIA_ROOT. Usage: node server/scripts/private-media.js verify|cleanup --confirm-operator. No dotenv is loaded.",
  );
if (!process.env.PRIVATE_MEDIA_ROOT)
  throw Error("Explicit PRIVATE_MEDIA_ROOT is required.");
const db = await connectDatabase(),
  service = privateMediaService(db, loadConfig());
try {
  if (action === "cleanup") {
    const processing = processingIntents(db, loadConfig(), service.storage);
    await processing.reconcile();
    await processing.sweep();
    await service.sweep();
    console.log(JSON.stringify({ action, batchLimit: 50 }));
  } else {
    let cursor = "",
      checked = 0,
      unavailable = 0;
    for (const [table, status] of [
      ["private_media_assets", "validated"],
      ["private_media_outputs", "ready"],
    ]) {
      cursor = "";
      while (true) {
        const rows = await db
          .prepare(
            `SELECT id,object_key,checksum,byte_size FROM ${table} WHERE status='${status}' AND id>? ORDER BY id LIMIT 50`,
          )
          .all(cursor);
        if (!rows.length) break;
        for (const a of rows) {
          let h;
          checked++;
          try {
            h = await service.storage.read(a.object_key);
            if ((await h.stat()).size !== a.byte_size) throw Error("size");
            const hash = createHash("sha256");
            for await (const chunk of h.createReadStream({ autoClose: false }))
              hash.update(chunk);
            if (hash.digest("hex") !== a.checksum) throw Error("hash");
          } catch {
            unavailable++;
          } finally {
            await h?.close().catch(() => {});
          }
          cursor = a.id;
        }
      }
    }
    console.log(JSON.stringify({ action, checked, unavailable }));
    if (unavailable) process.exitCode = 1;
  }
} finally {
  await db.close();
}
