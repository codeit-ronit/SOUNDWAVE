import {
  persistProcessingIntent,
  privateUsage,
  processingView,
  outputView,
} from "./processing-intents.js";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { authorizationService } from "./authorization.js";
import { localPrivateStorage } from "../storage/local-private.js";
export const mediaError = (status, code, message) =>
  Object.assign(Error(message), { status, mediaCode: code });
const fail = (status, code, message) => {
  throw mediaError(status, code, message);
};
const publicAsset = (r) =>
  r && {
    id: r.id,
    revision: r.revision,
    status: r.status,
    byteSize: r.byte_size,
    reservedBytes: r.reserved_bytes,
    checksum: r.checksum,
    detectedType: r.detected_type,
    durationSeconds: r.duration_seconds,
    validationVersion: r.validation_version,
    expiresAt: r.expires_at,
    errorCode: r.error_code,
    cleanupPending:
      !r.storage_released && ["failed", "deleted"].includes(r.status),
    updatedAt: r.updated_at,
  };
export function privateMediaService(
  db,
  config,
  storage = localPrivateStorage(config.privateMediaRoot),
) {
  const auth = authorizationService(db),
    now = () => new Date().toISOString();
  const row = (id) =>
    db.prepare("SELECT * FROM private_media_assets WHERE id=?").get(id);
  async function chapter(principal, storyId, chapterId, editable = false) {
    await auth.ownedStory(principal, storyId);
    const story = await db
      .prepare("SELECT * FROM stories WHERE id=?")
      .get(storyId);
    const c = await db
      .prepare("SELECT * FROM chapters WHERE story_id=? AND id=?")
      .get(storyId, chapterId);
    if (!c) fail(404, "MEDIA_NOT_FOUND", "Media not found.");
    if (editable && (story.draft_state !== "draft" || c.draft_removed))
      fail(409, "DRAFT_UNAVAILABLE", "This chapter no longer accepts media.");
    return { story, c };
  }
  async function owned(principal, storyId, chapterId, id, editable = false) {
    const state = await chapter(principal, storyId, chapterId, editable),
      a = await row(id);
    if (
      !a ||
      a.user_id !== principal.id ||
      a.story_id !== storyId ||
      a.chapter_id !== chapterId
    )
      fail(404, "MEDIA_NOT_FOUND", "Media not found.");
    return { ...state, a };
  }
  const head = (chapterId) =>
    db
      .prepare("SELECT * FROM private_media_heads WHERE chapter_id=?")
      .get(chapterId);
  const usage = (user) => privateUsage(db, user);
  async function status(principal, storyId, chapterId) {
    return db.transaction(async () => {
      const state = await chapter(principal, storyId, chapterId);
      const h = await head(chapterId),
        recent = await db
          .prepare(
            "SELECT * FROM private_media_assets WHERE user_id=? AND chapter_id=? ORDER BY created_at DESC,id DESC LIMIT 5",
          )
          .all(principal.id, chapterId);
      const current = h?.asset_id ? await row(h.asset_id) : null;
      const processing = current
        ? await db
            .prepare(
              "SELECT * FROM private_processing_intents WHERE asset_id=?",
            )
            .get(current.id)
        : null;
      const derivative =
        processing?.status === "ready"
          ? await db
              .prepare(
                "SELECT * FROM private_media_outputs WHERE intent_id=? AND status='ready'",
              )
              .get(processing.id)
          : null;
      return {
        processingIntent: processingView(processing),
        derivative: outputView(derivative),
        canPreview:
          state.story.draft_state === "draft" && !state.c.draft_removed,
        headRevision: h?.revision || 0,
        current: h?.asset_id ? publicAsset(await row(h.asset_id)) : null,
        recent: recent.map(publicAsset),
        usedBytes: await usage(principal.id),
        maxBytes: config.uploadMaxBytes,
        quotaBytes: config.creatorStorageBytes,
        acceptedType: "audio/wav",
        processing: "Technical PCM validation only; unpublished.",
      };
    });
  }
  async function sweep(user) {
    const time = now();
    const candidates = await db
      .prepare(
        `SELECT a.id,a.user_id FROM private_media_assets a JOIN stories s ON s.id=a.story_id JOIN chapters c ON c.id=a.chapter_id WHERE a.storage_released=0 ${user ? "AND a.user_id=?" : ""} AND ((a.status IN ('failed','deleted') AND (a.lease_until IS NULL OR a.lease_until<=?)) OR (a.status='reserved' AND a.expires_at<=?) OR (a.status IN ('uploading','quarantined') AND a.lease_until<=?) OR (a.status='validated' AND (s.draft_state='archived' OR c.draft_removed=1))) ORDER BY a.updated_at,a.id LIMIT 50`,
      )
      .all(...(user ? [user] : []), time, time, time);
    for (const candidate of candidates)
      await db.transaction(async () => {
        await auth.registered({ id: candidate.user_id }, true);
        let a = await row(candidate.id);
        if (!a || a.storage_released) return;
        if (a.lease_until && a.lease_until > now()) return;
        if (
          await db
            .prepare(
              "SELECT id FROM private_processing_intents WHERE asset_id=? AND lease_until>?",
            )
            .get(a.id, now())
        )
          return;
        const c = await db
          .prepare(
            "SELECT s.draft_state,c.draft_removed FROM chapters c JOIN stories s ON s.id=c.story_id WHERE c.id=?",
          )
          .get(a.chapter_id);
        if (
          a.status === "validated" &&
          c.draft_state !== "archived" &&
          !c.draft_removed
        )
          return;
        if (a.status === "reserved" && a.expires_at > now()) return;
        await db
          .prepare(
            "UPDATE private_media_assets SET status=?,error_code=COALESCE(error_code,?),revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(
            a.status === "validated"
              ? "deleted"
              : a.status === "deleted"
                ? "deleted"
                : "failed",
            "UPLOAD_EXPIRED",
            now(),
            a.id,
          );
        await db
          .prepare(
            "UPDATE private_media_heads SET asset_id=NULL,revision=revision+1 WHERE asset_id=?",
          )
          .run(a.id);
        try {
          if (
            await db
              .prepare(
                "SELECT id FROM private_media_outputs WHERE object_key=?",
              )
              .get(a.object_key)
          )
            throw Error("ambiguous_key");
          await storage.remove(a.object_key);
          await db
            .prepare(
              "UPDATE private_media_assets SET storage_released=1,cleanup_error=0,lease_token=NULL,lease_until=NULL WHERE id=?",
            )
            .run(a.id);
        } catch {
          await db
            .prepare(
              "UPDATE private_media_assets SET cleanup_error=1 WHERE id=?",
            )
            .run(a.id);
        }
      });
  }
  return {
    storage,
    status,
    sweep,
    publicAsset,
    reserve: async (principal, storyId, chapterId, body) => {
      return db.transaction(async () => {
        const { c } = await chapter(principal, storyId, chapterId, true);
        await sweep(principal.id);
        const hash = createHash("sha256")
          .update(
            JSON.stringify([
              storyId,
              chapterId,
              body.byteSize,
              body.expectedChapterRevision,
              body.expectedHeadRevision,
            ]),
          )
          .digest("hex");
        const old = await db
          .prepare(
            "SELECT * FROM private_media_assets WHERE user_id=? AND request_id=?",
          )
          .get(principal.id, body.requestId.toLowerCase());
        if (old) {
          if (old.request_hash !== hash)
            fail(
              409,
              "UPLOAD_REQUEST_REUSED",
              "Request ID belongs to a different upload.",
            );
          return { asset: publicAsset(old), replayed: true };
        }
        if (c.draft_revision !== body.expectedChapterRevision)
          fail(
            409,
            "MEDIA_CONFLICT",
            "Chapter changed. Refresh before uploading.",
          );
        const h = await head(chapterId);
        if ((h?.revision || 0) !== body.expectedHeadRevision)
          fail(
            409,
            "MEDIA_CONFLICT",
            "Chapter media changed. Refresh before uploading.",
          );
        if (
          (
            await db
              .prepare(
                "SELECT COUNT(*) AS n FROM private_media_assets WHERE user_id=?",
              )
              .get(principal.id)
          ).n >= 1000
        )
          fail(409, "MEDIA_LIMIT", "Retained upload limit reached.");
        if (
          await db
            .prepare(
              "SELECT id FROM private_media_assets WHERE chapter_id=? AND status IN ('reserved','uploading','quarantined')",
            )
            .get(chapterId)
        )
          fail(
            409,
            "UPLOAD_PENDING",
            "Resolve or cancel the existing upload first.",
          );
        if (
          (await usage(principal.id)) + body.byteSize >
          config.creatorStorageBytes
        )
          fail(
            409,
            "STORAGE_QUOTA",
            "Creator storage quota exceeded. Cleanup must finish before quota is released.",
          );
        const id = randomUUID();
        await db
          .prepare(
            "INSERT INTO private_media_assets(id,user_id,story_id,chapter_id,request_id,request_hash,object_key,status,reserved_bytes,expected_chapter_revision,expected_head_revision,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'reserved',?,?,?,?,?,?)",
          )
          .run(
            id,
            principal.id,
            storyId,
            chapterId,
            body.requestId.toLowerCase(),
            hash,
            randomBytes(32).toString("hex"),
            body.byteSize,
            body.expectedChapterRevision,
            body.expectedHeadRevision,
            new Date(
              Date.now() + config.uploadReservationSeconds * 1000,
            ).toISOString(),
            now(),
            now(),
          );
        await db
          .prepare(
            "INSERT INTO private_media_heads(chapter_id,story_id,user_id) VALUES(?,?,?) ON CONFLICT DO NOTHING",
          )
          .run(chapterId, storyId, principal.id);
        return { asset: publicAsset(await row(id)), replayed: false };
      });
    },
    read: (p, s, c, id) =>
      db.transaction(async () => publicAsset((await owned(p, s, c, id)).a)),
    claim: (p, s, c, id) =>
      db.transaction(async () => {
        const { a } = await owned(p, s, c, id, true);
        if (a.status === "validated") return { a, replayed: true };
        if (a.status !== "reserved" || a.expires_at <= now())
          fail(
            409,
            "UPLOAD_NOT_RESERVED",
            "Upload is no longer reserved. Refresh its status.",
          );
        const token = randomUUID();
        await db
          .prepare(
            "UPDATE private_media_assets SET status='uploading',revision=revision+1,lease_token=?,lease_until=?,updated_at=? WHERE id=?",
          )
          .run(
            token,
            new Date(
              Date.now() + (config.uploadSeconds + 30) * 1000,
            ).toISOString(),
            now(),
            id,
          );
        return { a: await row(id), token, replayed: false };
      }),
    quarantine: (id, token, bytes, checksum) =>
      db.transaction(async () => {
        let a = await row(id);
        await auth.registered({ id: a.user_id }, true);
        a = await row(id);
        if (a.status !== "uploading" || a.lease_token !== token)
          fail(409, "UPLOAD_CANCELLED", "Upload was cancelled.");
        await db
          .prepare(
            "UPDATE private_media_assets SET status='quarantined',byte_size=?,checksum=?,revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(bytes, checksum, now(), id);
      }),
    finish: (p, s, c, id, token, metadata, sessionHash) =>
      db.transaction(async () => {
        const { a, c: chapterRow } = await owned(p, s, c, id, true);
        const session = await db
          .prepare(
            `SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>${db.now}`,
          )
          .get(sessionHash);
        if (session?.user_id !== p.id)
          fail(
            401,
            "UPLOAD_SESSION_EXPIRED",
            "Session expired during upload. Sign in again.",
          );
        if (
          a.status !== "quarantined" ||
          a.lease_token !== token ||
          a.lease_until <= now()
        )
          fail(409, "UPLOAD_CANCELLED", "Upload was cancelled or expired.");
        const h = await head(c);
        if (
          chapterRow.draft_revision !== a.expected_chapter_revision ||
          h.revision !== a.expected_head_revision
        )
          fail(
            409,
            "MEDIA_CONFLICT",
            "Chapter changed during upload. Refresh before replacing media.",
          );
        if (h.asset_id)
          await db
            .prepare(
              "UPDATE private_media_assets SET status='deleted',revision=revision+1,updated_at=? WHERE id=?",
            )
            .run(now(), h.asset_id);
        await db
          .prepare(
            "UPDATE private_media_assets SET status='validated',detected_type='audio/wav',duration_seconds=?,validation_version=1,revision=revision+1,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?",
          )
          .run(metadata.durationSeconds, now(), id);
        await db
          .prepare(
            "UPDATE private_media_heads SET asset_id=?,revision=revision+1 WHERE chapter_id=?",
          )
          .run(id, c);
        await persistProcessingIntent(
          db,
          await row(id),
          await head(c),
          chapterRow,
        );
        return publicAsset(await row(id));
      }),
    fail: async (id, token, code) => {
      await db.transaction(async () => {
        let a = await row(id);
        if (!a) return;
        await auth.registered({ id: a.user_id }, true);
        a = await row(id);
        if (a.lease_token !== token) return;
        await db
          .prepare(
            "UPDATE private_media_assets SET status=?,error_code=?,lease_until=NULL,lease_token=NULL,revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(a.status === "deleted" ? "deleted" : "failed", code, now(), id);
      });
      const a = await row(id);
      if (a) await sweep(a.user_id);
    },
    remove: async (p, s, c, id, expected) => {
      const result = await db.transaction(async () => {
        const { a } = await owned(p, s, c, id);
        if (a.revision !== expected)
          fail(
            409,
            "MEDIA_CONFLICT",
            "Asset changed. Refresh before deleting.",
          );
        if (a.status !== "deleted") {
          await db
            .prepare(
              "UPDATE private_media_assets SET status='deleted',revision=revision+1,updated_at=? WHERE id=?",
            )
            .run(now(), id);
          await db
            .prepare(
              "UPDATE private_media_heads SET asset_id=NULL,revision=revision+1 WHERE asset_id=?",
            )
            .run(id);
        }
        return publicAsset(await row(id));
      });
      await sweep(p.id);
      return result;
    },
    preview: (p, s, c, id) =>
      db.transaction(async () => {
        const { a, story, c: ch } = await owned(p, s, c, id);
        if (
          story.draft_state !== "draft" ||
          ch.draft_removed ||
          a.status !== "validated" ||
          (await head(c))?.asset_id !== id
        )
          fail(404, "MEDIA_NOT_FOUND", "Media not found.");
        return a;
      }),
  };
}
