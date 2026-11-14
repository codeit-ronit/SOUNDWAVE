import { localPrivateStorage } from "../storage/local-private.js";
import { publicStory } from "../services/publication-visibility.js";
import { parseRange } from "./stream.js";
// No redirects/static mounts: the service selects the exact approved private object.
export async function publishedAudio(db, config, storage, req, res, next) {
  let h;
  try {
    const o = await db
      .prepare(
        `SELECT o.* FROM publication_chapters pc JOIN private_media_outputs o ON o.id=pc.output_id JOIN stories s ON s.id=pc.story_id WHERE pc.chapter_id=? AND ${publicStory()}`,
      )
      .get(Number(req.params.id));
    if (!o)
      return res.status(404).json({ error: { message: "Chapter not found." } });
    h = await (storage || localPrivateStorage(config.privateMediaRoot)).read(
      o.object_key,
    );
    const stat = await h.stat();
    if (stat.size !== o.byte_size) throw Error("Missing output");
    // Authorize again after the asynchronous storage open. Already delivered bytes
    // cannot be recalled, but every new HEAD/range/full request rechecks SQL.
    const authorized = await db
      .prepare(
        `SELECT s.id FROM stories s JOIN publication_chapters pc ON pc.story_id=s.id WHERE pc.chapter_id=? AND pc.output_id=? AND ${publicStory()}`,
      )
      .get(Number(req.params.id), o.id);
    if (!authorized) {
      await h.close();
      h = null;
      return res.status(404).json({ error: { message: "Chapter not found." } });
    }
    res.set({
      ETag: `"${o.checksum}"`,
      "Content-Type": "audio/mpeg",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Disposition": 'inline; filename="chapter.mp3"',
    });
    const range =
      req.method === "GET" && req.get("Range")
        ? parseRange(req.get("Range"), stat.size)
        : null;
    if (req.method === "GET" && req.get("Range") && !range) {
      await h.close();
      h = null;
      return res
        .status(416)
        .set({ "Content-Range": `bytes */${stat.size}`, "Content-Length": "0" })
        .end();
    }
    res
      .status(range ? 206 : 200)
      .set(
        "Content-Length",
        String(range ? range.end - range.start + 1 : stat.size),
      );
    if (range)
      res.set(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${stat.size}`,
      );
    if (req.method === "HEAD" || res.destroyed) {
      await h.close();
      h = null;
      return res.end();
    }
    const stream = h.createReadStream(range || {});
    h = null;
    res.once("close", () => stream.destroy());
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch (e) {
    await h?.close().catch(() => {});
    if (res.headersSent) return res.destroy();
    res
      .status(503)
      .json({ error: { message: "Audio is temporarily unavailable." } });
  }
}
