import { Router } from "express";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { requireUser } from "../middleware/auth.js";
import { fields, uuid, draftId, revision } from "../services/draft-contract.js";
import { privateMediaService, mediaError } from "../services/private-media.js";
import { validatePrivateWav } from "../media/private-validation.js";
import { parseRange } from "./stream.js";
export function privateMediaRouter(db, config, injectedStorage) {
  const r = Router(),
    service = privateMediaService(db, config, injectedStorage);
  const base = "/stories/:story/chapters/:chapter/media";
  r.use(requireUser);
  for (const key of ["story", "chapter"])
    r.param(key, (req, res, next, v) =>
      draftId(v)
        ? next()
        : next(
            mediaError(400, "INVALID_MEDIA_REQUEST", "Invalid resource ID."),
          ),
    );
  r.param("asset", (req, res, next, v) =>
    uuid(v)
      ? next()
      : next(mediaError(400, "INVALID_MEDIA_REQUEST", "Invalid asset ID.")),
  );
  const ids = (req) => [
    req.user,
    Number(req.params.story),
    Number(req.params.chapter),
  ];
  const cleanQuery = (req) => {
    if (Object.keys(req.query).length)
      throw mediaError(
        400,
        "INVALID_MEDIA_REQUEST",
        "No query selectors accepted.",
      );
  };
  r.get(base, async (req, res) => {
    cleanQuery(req);
    res.json(await service.status(...ids(req)));
  });
  r.post(base, async (req, res) => {
    cleanQuery(req);
    fields(req.body, [
      "requestId",
      "byteSize",
      "expectedChapterRevision",
      "expectedHeadRevision",
    ]);
    const b = req.body;
    if (
      !uuid(b.requestId) ||
      !Number.isSafeInteger(b.byteSize) ||
      b.byteSize < 1 ||
      b.byteSize > config.uploadMaxBytes ||
      !revision(b.expectedChapterRevision) ||
      !Number.isSafeInteger(b.expectedHeadRevision) ||
      b.expectedHeadRevision < 0
    )
      throw mediaError(
        400,
        "INVALID_MEDIA_REQUEST",
        "Provide a UUID, bounded positive byteSize and current chapter/media revisions.",
      );
    const result = await service.reserve(...ids(req), b);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  r.get(base + "/:asset", async (req, res) => {
    cleanQuery(req);
    res.json({ asset: await service.read(...ids(req), req.params.asset) });
  });
  r.delete(base + "/:asset", async (req, res) => {
    cleanQuery(req);
    fields(req.body, ["expectedRevision"]);
    if (!revision(req.body.expectedRevision))
      throw mediaError(
        400,
        "INVALID_MEDIA_REQUEST",
        "expectedRevision is required.",
      );
    res.json({
      asset: await service.remove(
        ...ids(req),
        req.params.asset,
        req.body.expectedRevision,
      ),
    });
  });
  r.put(base + "/:asset/bytes", async (req, res, next) => {
    let claim, handle, read, limiter, timer, timeoutError;
    const interrupted = () =>
      limiter?.destroy(
        mediaError(400, "UPLOAD_INTERRUPTED", "Upload interrupted."),
      );
    try {
      cleanQuery(req);
      if (
        !["audio/wav", "audio/x-wav", "application/octet-stream"].includes(
          (req.get("Content-Type") || "").split(";")[0].trim().toLowerCase(),
        )
      )
        throw mediaError(
          415,
          "UNSUPPORTED_AUDIO",
          "Only PCM WAV upload bodies are accepted.",
        );
      claim = await service.claim(...ids(req), req.params.asset);
      if (claim.replayed)
        return res
          .set("Connection", "close")
          .json({ asset: service.publicAsset(claim.a), replayed: true });
      if (
        req.get("Content-Length") !== undefined &&
        Number(req.get("Content-Length")) !== claim.a.reserved_bytes
      )
        throw mediaError(
          400,
          "UPLOAD_LENGTH",
          "Content-Length must equal the reservation.",
        );
      let bytes = 0;
      const hash = createHash("sha256");
      limiter = new Transform({
        transform(chunk, enc, cb) {
          bytes += chunk.length;
          if (bytes > claim.a.reserved_bytes || bytes > config.uploadMaxBytes)
            return cb(
              mediaError(
                413,
                "UPLOAD_TOO_LARGE",
                "Upload exceeded its reserved byte limit.",
              ),
            );
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      timer = setTimeout(() => {
        timeoutError = mediaError(408, "UPLOAD_TIMEOUT", "Upload timed out.");
        limiter.destroy(timeoutError);
      }, config.uploadSeconds * 1000);
      timer.unref();
      handle = await service.storage.create(claim.a.object_key);
      req.once("aborted", interrupted);
      req.once("error", interrupted);
      if (req.aborted)
        throw mediaError(400, "UPLOAD_INTERRUPTED", "Upload interrupted.");
      const output = handle.createWriteStream({ autoClose: true, flush: true });
      req.pipe(limiter);
      await pipeline(limiter, output);
      handle = null;
      if (!bytes || bytes !== claim.a.reserved_bytes)
        throw mediaError(422, "UPLOAD_LENGTH", "File is empty or truncated.");
      await service.quarantine(
        claim.a.id,
        claim.token,
        bytes,
        hash.digest("hex"),
      );
      read = await service.storage.read(claim.a.object_key);
      const metadata = await validatePrivateWav(read);
      await read.close();
      read = null;
      if (timeoutError) throw timeoutError;
      const asset = await service.finish(
        ...ids(req),
        claim.a.id,
        claim.token,
        metadata,
        req.sessionHash,
      );
      await service.sweep(req.user.id);
      res.json({ asset, replayed: false });
    } catch (error) {
      if (claim && !claim.replayed)
        try {
          await service.fail(
            claim.a.id,
            claim.token,
            error.mediaCode || "STORAGE_WRITE_FAILED",
          );
        } catch {
          console.error("Private upload cleanup pending");
        }
      if (!req.complete) res.set("Connection", "close");
      if (!req.aborted && !res.destroyed)
        next(
          error.mediaCode || error.permissionCode || error.draftCode
            ? error
            : mediaError(
                503,
                "STORAGE_UNAVAILABLE",
                "Private storage is unavailable. Refresh upload status before retrying.",
              ),
        );
    } finally {
      clearTimeout(timer);
      req.unpipe(limiter);
      req.off("aborted", interrupted);
      req.off("error", interrupted);
      await handle?.close().catch(() => {});
      await read?.close().catch(() => {});
    }
  });
  async function preview(req, res, next) {
    let h;
    try {
      cleanQuery(req);
      const a = await service.preview(...ids(req), req.params.asset);
      h = await service.storage.read(a.object_key);
      const stat = await h.stat();
      if (stat.size !== a.byte_size)
        throw mediaError(
          503,
          "MEDIA_UNAVAILABLE",
          "Stored media needs recovery.",
        );
      const range = req.get("Range")
        ? parseRange(req.get("Range"), stat.size)
        : null;
      res.set({
        "Content-Type": "audio/wav",
        "Content-Disposition": 'inline; filename="private-audio.wav"',
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
      });
      if (req.get("Range") && !range) {
        await h.close();
        h = null;
        return res
          .status(416)
          .set("Content-Range", `bytes */${stat.size}`)
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
      next(
        e.mediaCode || e.permissionCode
          ? e
          : mediaError(
              503,
              "MEDIA_UNAVAILABLE",
              "Stored media needs recovery.",
            ),
      );
    }
  }
  r.route(base + "/:asset/preview")
    .get(preview)
    .head(preview);
  r.use((e, req, res, next) => {
    const code = e.mediaCode || e.permissionCode || e.draftCode;
    if (!code) return next(e);
    res.status(e.status).json({ error: { code, message: e.message } });
  });
  return r;
}
