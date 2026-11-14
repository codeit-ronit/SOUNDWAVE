import { Router } from "express";
import { requireUser } from "../middleware/auth.js";
import { publicationService } from "../services/publications.js";
import { fields, uuid, draftId } from "../services/draft-contract.js";
import { permissionError } from "../services/authorization.js";
import { eligiblePublication } from "../services/publication-visibility.js";
import { localPrivateStorage } from "../storage/local-private.js";
import { parseRange } from "./stream.js";
export function publicationRouter(
  db,
  config,
  storage = localPrivateStorage(config.privateMediaRoot),
) {
  const r = Router(),
    service = publicationService(db, config, storage);
  r.use((req, res, next) =>
    /^\/moderation(?:\/|$)|^\/creator\/stories\/[1-9]\d{0,8}\/publication(?:\/|$)/.test(
      req.path,
    )
      ? next()
      : next("router"),
  );
  r.use(requireUser, (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (Object.keys(req.query).length)
      return next(
        permissionError(
          400,
          "INVALID_PUBLICATION",
          "No query selectors accepted.",
        ),
      );
    next();
  });
  r.param("id", (req, res, next, id) =>
    draftId(id)
      ? next()
      : next(permissionError(400, "INVALID_PUBLICATION", "Invalid story ID.")),
  );
  r.get("/moderation/submissions", async (req, res) =>
    res.json(await service.pending(req.user)),
  );
  r.get("/moderation/stories/:id", async (req, res) =>
    res.json(await service.read(req.user, Number(req.params.id), true)),
  );
  r.get("/creator/stories/:id/publication", async (req, res) =>
    res.json(await service.read(req.user, Number(req.params.id))),
  );
  // Narrow capability: exact current submission output, never arbitrary owner/asset selectors.
  async function reviewAudio(req, res, next) {
    let h;
    try {
      const d = await service.read(req.user, Number(req.params.id), true);
      if (
        !d.current ||
        !["submitted", "approved", "published"].includes(d.publication.state) ||
        !uuid(req.params.output) ||
        !d.chapters.some((c) => c.outputId === req.params.output)
      )
        throw permissionError(
          404,
          "REVIEW_MEDIA_NOT_FOUND",
          "Review media not found.",
        );
      // Recheck authorization/eligibility together with the object lookup, after awaits.
      const o = await db
        .prepare(
          `SELECT o.* FROM private_media_outputs o JOIN publication_chapters pc ON pc.output_id=o.id JOIN stories s ON s.id=pc.story_id JOIN story_publications pub ON pub.story_id=s.id WHERE s.id=? AND o.id=? AND pub.state IN ('submitted','approved','published') AND ${eligiblePublication()}`,
        )
        .get(Number(req.params.id), req.params.output);
      if (!o)
        throw permissionError(
          404,
          "REVIEW_MEDIA_NOT_FOUND",
          "Review media not found.",
        );
      h = await storage.read(o.object_key);
      const stat = await h.stat();
      if (stat.size !== o.byte_size)
        throw permissionError(
          503,
          "MEDIA_UNAVAILABLE",
          "Review media needs recovery.",
        );
      const range =
        req.method === "GET" && req.get("Range")
          ? parseRange(req.get("Range"), stat.size)
          : null;
      res.set({
        "Content-Type": "audio/mpeg",
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      });
      if (req.method === "GET" && req.get("Range") && !range) {
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
        e.permissionCode
          ? e
          : permissionError(
              503,
              "MEDIA_UNAVAILABLE",
              "Review media needs recovery.",
            ),
      );
    }
  }
  r.route("/moderation/stories/:id/outputs/:output/stream")
    .get(reviewAudio)
    .head(reviewAudio);
  const transition = (staff) => async (req, res) => {
    const allowed = staff
      ? ["approve", "reject", "revoke", "suspend"]
      : ["submit", "withdraw", "publish", "unpublish"];
    if (!allowed.includes(req.params.action))
      throw permissionError(400, "INVALID_ACTION", "Unsupported action.");
    fields(req.body, [
      "expectedRevision",
      "requestId",
      ...(req.params.action === "submit"
        ? ["attest", "termsVersion"]
        : staff
          ? ["code", "note"]
          : []),
    ]);
    const b = req.body;
    if (
      !Number.isSafeInteger(b.expectedRevision) ||
      b.expectedRevision < 0 ||
      !uuid(b.requestId) ||
      (staff &&
        (typeof b.note !== "string" || !b.note.trim() || b.note.length > 1000))
    )
      throw permissionError(
        400,
        "INVALID_PUBLICATION",
        "Provide a current revision, UUID requestId and required bounded decision note.",
      );
    res.json(
      await service.transition(
        req.user,
        Number(req.params.id),
        req.params.action,
        b,
      ),
    );
  };
  r.post("/creator/stories/:id/publication/:action", transition(false));
  r.post("/moderation/stories/:id/:action", transition(true));
  r.use((e, req, res, next) => {
    if (!e.permissionCode && !e.draftCode) return next(e);
    res.status(e.status).json({
      error: { code: e.permissionCode || e.draftCode, message: e.message },
    });
  });
  return r;
}
