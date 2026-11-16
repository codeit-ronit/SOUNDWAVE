import { createHash } from "node:crypto";
// This cache remembers byte integrity, never publication/ownership authorization.
// Recheck OS identity on EVERY request; SQL authorization still runs afterwards.
const caches = new WeakMap();
export const fileSignature = (s) =>
  [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
export async function checkOpenOutput(db, handle, output) {
  const before = await handle.stat({ bigint: true });
  if (Number(before.size) !== output.byte_size || output.byte_size > 16777216)
    throw Error("Output integrity failure");
  const signature = fileSignature(before),
    key = output.id + ":" + output.checksum + ":" + signature;
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  const old = cache.get(key);
  if (old && old > Date.now()) return;
  const digest = createHash("sha256"),
    stream = handle.createReadStream({ start: 0, autoClose: false });
  let size = 0;
  const timeout = setTimeout(
    () => stream.destroy(Error("Output verification timeout")),
    15000,
  );
  timeout.unref();
  try {
    for await (const bytes of stream) {
      size += bytes.length;
      if (size > output.byte_size) throw Error("Output size changed");
      digest.update(bytes);
    }
  } finally {
    clearTimeout(timeout);
    if (!stream.readableEnded) stream.destroy();
  }
  if (
    size !== output.byte_size ||
    digest.digest("hex") !== output.checksum ||
    fileSignature(await handle.stat({ bigint: true })) !== signature
  )
    throw Error("Output integrity failure");
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(key, Date.now() + 30000);
}
