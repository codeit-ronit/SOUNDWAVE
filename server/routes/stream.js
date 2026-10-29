import { Router } from "express";
import { open, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";

// Single byte ranges only. Never accept a client-supplied filename.
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] === "" ? null : Number(match[1]);
  const last = match[2] === "" ? null : Number(match[2]);
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  )
    return null;
  if (first === null) {
    if (!last || !size) return null;
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== null && last < first)) return null;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

export function createAudioHandler(db) {
  const root = fileURLToPath(new URL("../public/audio/", import.meta.url));
  async function serve(req, res, next) {
    let handle;
    try {
      if (!/^[1-9]\d{0,8}$/.test(req.params.id))
        return res
          .status(400)
          .json({ error: { message: "Invalid chapter ID." } });
      const chapter = db
        .prepare("SELECT audio_url FROM chapters WHERE id=?")
        .get(Number(req.params.id));
      if (!chapter)
        return res
          .status(404)
          .json({ error: { message: "Chapter not found." } });
      // Restrict database mappings as well as the resolved path (including symlinks).
      if (!/^\/audio\/[1-9]\d*-[1-9]\d*\.wav$/.test(chapter.audio_url))
        return res
          .status(404)
          .json({ error: { message: "Audio file not found." } });
      const [base, path] = await Promise.all([
        realpath(root),
        realpath(resolve(root, chapter.audio_url.slice("/audio/".length))),
      ]);
      if (!path.startsWith(base + sep))
        return res
          .status(404)
          .json({ error: { message: "Audio file not found." } });
      handle = await open(path, "r");
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        handle = null;
        return res
          .status(404)
          .json({ error: { message: "Audio file not found." } });
      }
      const size = stat.size;
      const etag = `"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      res.set({
        "Content-Type": "audio/wav",
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
        ETag: etag,
        "Last-Modified": stat.mtime.toUTCString(),
      });
      // RFC 9110: Range is a modifier for GET; HEAD describes the full representation.
      let range;
      const ifRange = req.get("If-Range");
      const rangeAllowed =
        !ifRange || ifRange === etag || ifRange === stat.mtime.toUTCString();
      if (req.method === "GET" && req.headers.range && rangeAllowed) {
        range = parseRange(req.headers.range, size);
        if (!range) {
          await handle.close();
          handle = null;
          return res
            .status(416)
            .set({ "Content-Range": `bytes */${size}`, "Content-Length": "0" })
            .end();
        }
      }
      const start = range?.start ?? 0,
        end = range?.end ?? size - 1;
      res
        .status(range ? 206 : 200)
        .set("Content-Length", String(end - start + 1));
      if (range) res.set("Content-Range", `bytes ${start}-${end}/${size}`);
      if (req.method === "HEAD") {
        await handle.close();
        handle = null;
        return res.end();
      }
      // FileHandle#createReadStream closes its descriptor; no full-file Buffer allocation.
      const stream = handle.createReadStream({ start, end, autoClose: true });
      handle = null;
      res.on("close", () => stream.destroy());
      stream.on("error", (err) => {
        if (res.headersSent) res.destroy(err);
        else next(err);
      });
      stream.pipe(res);
    } catch (err) {
      if (handle) await handle.close().catch(() => {});
      if (err.code === "ENOENT")
        return res
          .status(404)
          .json({ error: { message: "Audio file not found." } });
      next(err);
    }
  }
  return serve;
}

export function streamRouter(db) {
  const router = Router();
  const serve = createAudioHandler(db);
  router.route("/chapters/:id/stream").get(serve).head(serve);
  return router;
}

export function legacyAudioRouter(db) {
  const router = Router();
  const serve = createAudioHandler(db);
  const legacy = (req, res, next) => {
    const chapter = db
      .prepare("SELECT id FROM chapters WHERE audio_url=?")
      .get(`/audio/${req.params.filename}`);
    if (!chapter)
      return res
        .status(404)
        .json({ error: { message: "Audio file not found." } });
    req.params.id = String(chapter.id);
    return serve(req, res, next);
  };
  router.route("/:filename").get(legacy).head(legacy);
  router.use((_req, res) =>
    res.status(404).json({ error: { message: "Audio file not found." } }),
  );
  return router;
}
