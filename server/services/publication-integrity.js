import { createHash } from "node:crypto";
import { permissionError } from "./authorization.js";
import { telemetry } from "../telemetry.js";
const active = new WeakMap();
const signature = (s) =>
  [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
const changed = () =>
  permissionError(
    409,
    "NOT_READY",
    "Processed media changed or is unavailable. Refresh and retry.",
  );
// Opaque proof remains request-local; descriptors are held until commit completes.
export async function verifyPublicationFiles(db, storage, files) {
  if ((active.get(db) || 0) >= 4)
    throw permissionError(
      503,
      "INTEGRITY_BUSY",
      "Media verification is busy. Retry shortly.",
    );
  active.set(db, (active.get(db) || 0) + 1);
  const handles = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.all(handles.map((x) => x.handle.close().catch(() => {})));
    active.set(db, active.get(db) - 1);
  };
  try {
    const deadline = Date.now() + 30000;
    for (const f of files) {
      const handle = await storage.read(f.object_key);
      const record = { handle, file: f };
      handles.push(record);
      const before = await handle.stat({ bigint: true });
      if (Number(before.size) !== f.byte_size) throw changed();
      const digest = createHash("sha256"),
        stream = handle.createReadStream({ autoClose: false });
      let count = 0;
      const timer = setTimeout(
        () => stream.destroy(changed()),
        Math.max(1, deadline - Date.now()),
      );
      timer.unref();
      try {
        for await (const bytes of stream) {
          count += bytes.length;
          if (count > f.byte_size || Date.now() > deadline) throw changed();
          digest.update(bytes);
        }
      } finally {
        clearTimeout(timer);
        if (!stream.readableEnded) stream.destroy();
      }
      const after = await handle.stat({ bigint: true });
      if (
        count !== f.byte_size ||
        digest.digest("hex") !== f.checksum ||
        signature(before) !== signature(after)
      )
        throw changed();
      record.signature = signature(after);
    }
    return {
      close,
      async recheck() {
        for (const r of handles) {
          let current;
          try {
            if (
              signature(await r.handle.stat({ bigint: true })) !== r.signature
            )
              throw changed();
            current = await storage.read(r.file.object_key);
            if (signature(await current.stat({ bigint: true })) !== r.signature)
              throw changed();
          } catch {
            throw changed();
          } finally {
            await current?.close().catch(() => {});
          }
        }
      },
    };
  } catch (e) {
    telemetry(db).observe("storage_failures", "integrity");
    await close();
    throw e.permissionCode ? e : changed();
  }
}
