import { randomUUID, randomBytes, createHash } from "node:crypto";
import { authorizationService } from "./authorization.js";
import { jobQueue } from "../jobs/queue.js";
const mediaError = (status, code, message) =>
  Object.assign(Error(message), { status, mediaCode: code });
export const PROCESSOR_VERSION = 1;
export const processingView = (r) =>
  r && {
    id: r.id,
    status: r.status,
    stage: r.stage,
    revision: r.revision,
    attempts: r.attempts,
    generation: r.generation,
    errorCode: r.error_code,
    processorVersion: r.processor_version,
    completedAt: r.completed_at,
  };
export const outputView = (r) =>
  r && {
    id: r.id,
    format: r.format,
    byteSize: r.byte_size,
    checksum: r.checksum,
    durationSeconds: r.duration_seconds,
    sampleRate: r.sample_rate,
    channels: r.channels,
  };
const time = () => new Date().toISOString();
// Caller holds the owner lock and surrounding upload/retry transaction.
export async function persistProcessingIntent(db, asset, head, chapter) {
  let row = await db
    .prepare("SELECT * FROM private_processing_intents WHERE asset_id=?")
    .get(asset.id);
  if (row) return row;
  const id = randomUUID(),
    key = `private-audio:${asset.id}:${asset.checksum}:processor-v1`,
    now = time();
  await db
    .prepare(
      "INSERT INTO private_processing_intents(id,asset_id,user_id,story_id,chapter_id,source_hash,processor_version,job_key,source_revision,head_revision,chapter_revision,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      asset.id,
      asset.user_id,
      asset.story_id,
      asset.chapter_id,
      asset.checksum,
      key,
      asset.revision,
      head.revision,
      chapter.draft_revision,
      now,
      now,
      now,
    );
  const outbox = await jobQueue(db).enqueue("maintenance", {
    owner: asset.user_id,
    key,
    payload: { intentId: id },
    topic: "private_audio",
  });
  await db
    .prepare("UPDATE private_processing_intents SET outbox_id=? WHERE id=?")
    .run(outbox, id);
  return db
    .prepare("SELECT * FROM private_processing_intents WHERE id=?")
    .get(id);
}
export async function privateUsage(db, user) {
  return (
    Number(
      (
        await db
          .prepare(
            "SELECT COALESCE(SUM(reserved_bytes),0) AS n FROM private_media_assets WHERE user_id=? AND storage_released=0",
          )
          .get(user)
      ).n,
    ) +
    Number(
      (
        await db
          .prepare(
            "SELECT COALESCE(SUM(o.reserved_bytes),0) AS n FROM private_media_outputs o JOIN private_processing_intents p ON p.id=o.intent_id WHERE p.user_id=? AND o.storage_released=0",
          )
          .get(user)
      ).n,
    )
  );
}
export function processingIntents(db, config, storage) {
  const auth = authorizationService(db),
    get = (id) =>
      db.prepare("SELECT * FROM private_processing_intents WHERE id=?").get(id);
  async function context(p) {
    return db
      .prepare(
        "SELECT a.*,s.owner_id,s.ownership_kind,s.draft_state,c.draft_removed,c.draft_revision AS chapter_revision,h.revision AS head_revision,h.asset_id AS current_asset,u.kind,cp.status AS creator_status FROM private_media_assets a JOIN stories s ON s.id=a.story_id JOIN chapters c ON c.id=a.chapter_id JOIN users u ON u.id=a.user_id LEFT JOIN creator_profiles cp ON cp.user_id=u.id LEFT JOIN private_media_heads h ON h.chapter_id=c.id WHERE a.id=?",
      )
      .get(p.asset_id);
  }
  function invalid(p, c) {
    if (
      !c ||
      c.current_asset !== p.asset_id ||
      c.status !== "validated" ||
      c.draft_state !== "draft" ||
      c.draft_removed ||
      c.user_id !== p.user_id ||
      c.owner_id !== p.user_id ||
      c.ownership_kind !== "creator" ||
      p.processor_version !== 1 ||
      c.checksum !== p.source_hash ||
      c.revision !== p.source_revision ||
      c.head_revision !== p.head_revision
    )
      return "SUPERSEDED";
    if (c.kind !== "registered" || c.creator_status !== "active")
      return "CREATOR_INACTIVE";
    if (p.status !== "ready" && c.chapter_revision !== p.chapter_revision)
      return "CHAPTER_CHANGED";
    return null;
  }
  async function retire(p, reason) {
    await db
      .prepare(
        "UPDATE private_processing_intents SET status=?,stage=?,error_code=?,revision=revision+1,updated_at=? WHERE id=?",
      )
      .run(
        reason === "SUPERSEDED" ? "superseded" : "failed",
        reason === "SUPERSEDED" ? "superseded" : "failed",
        reason,
        time(),
        p.id,
      );
    await db
      .prepare(
        "UPDATE private_media_outputs SET status='orphan' WHERE intent_id=? AND status IN ('ready','writing')",
      )
      .run(p.id);
  }
  async function fenced(id, token) {
    const before = await get(id);
    if (!before)
      throw mediaError(409, "STALE_PROCESSING", "Processing intent retired.");
    await auth.registered({ id: before.user_id }, true);
    const p = await get(id);
    if (
      p.status !== "processing" ||
      p.lease_token !== token ||
      p.lease_until <= time()
    )
      throw mediaError(409, "STALE_PROCESSING", "Processing lease retired.");
    return p;
  }
  return {
    get,
    context,
    invalid,
    async claim(id) {
      return db.transaction(async () => {
        let p = await get(id);
        if (!p) return null;
        await auth.registered({ id: p.user_id }, true);
        p = await get(id);
        if (
          ["ready", "failed", "superseded", "deleted"].includes(p.status) ||
          p.next_attempt_at > time() ||
          (p.status === "processing" && p.lease_until > time())
        )
          return null;
        const c = await context(p),
          reason = invalid(p, c);
        if (reason) {
          await retire(p, reason);
          return null;
        }
        if (p.cycle_attempts >= 4) {
          await retire(p, "ATTEMPTS_EXHAUSTED");
          return null;
        }
        // An expired attempt keeps its own key; never reuse an old writer's object.
        await db
          .prepare(
            "UPDATE private_media_outputs SET status='orphan' WHERE intent_id=? AND status='writing'",
          )
          .run(id);
        if (
          (await privateUsage(db, p.user_id)) + config.derivativeMaxBytes >
          config.creatorStorageBytes
        ) {
          await retire(p, "STORAGE_QUOTA");
          return null;
        }
        const token = randomUUID(),
          outputId = randomUUID(),
          until = new Date(
            Date.now() + (config.processingSeconds * 3 + 45) * 1000,
          ).toISOString();
        await db
          .prepare(
            "UPDATE private_processing_intents SET status='processing',stage='hashing',attempts=attempts+1,cycle_attempts=cycle_attempts+1,revision=revision+1,lease_token=?,lease_until=?,error_code=NULL,updated_at=? WHERE id=?",
          )
          .run(token, until, time(), id);
        await db
          .prepare(
            "INSERT INTO private_media_outputs(id,intent_id,object_key,fence_token,status,reserved_bytes,lease_until,created_at) VALUES(?,?,?,?,'writing',?,?,?)",
          )
          .run(
            outputId,
            id,
            randomBytes(32).toString("hex"),
            token,
            config.derivativeMaxBytes,
            until,
            time(),
          );
        return {
          intent: await get(id),
          source: c,
          token,
          output: await db
            .prepare("SELECT * FROM private_media_outputs WHERE id=?")
            .get(outputId),
        };
      });
    },
    async stage(id, token, stage) {
      return db.transaction(async () => {
        await fenced(id, token);
        await db
          .prepare(
            "UPDATE private_processing_intents SET stage=?,revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(stage, time(), id);
      });
    },
    async commit(id, token, outputId, metadata) {
      return db.transaction(async () => {
        const p = await fenced(id, token),
          reason = invalid(p, await context(p));
        if (reason) {
          await retire(p, reason);
          return false;
        }
        const out = await db
          .prepare(
            "SELECT * FROM private_media_outputs WHERE id=? AND intent_id=? AND fence_token=?",
          )
          .get(outputId, id, token);
        if (
          !out ||
          out.status !== "writing" ||
          metadata.byteSize > out.reserved_bytes
        )
          throw mediaError(409, "STALE_PROCESSING", "Output lease retired.");
        await db
          .prepare(
            "UPDATE private_media_outputs SET status='ready',reserved_bytes=?,byte_size=?,checksum=?,format='mp3',duration_seconds=?,sample_rate=44100,channels=2,lease_until=NULL,completed_at=? WHERE id=?",
          )
          .run(
            metadata.byteSize,
            metadata.byteSize,
            metadata.checksum,
            metadata.durationSeconds,
            time(),
            outputId,
          );
        await db
          .prepare(
            "UPDATE private_processing_intents SET status='ready',stage='ready',revision=revision+1,error_code=NULL,lease_token=NULL,lease_until=NULL,completed_at=?,updated_at=? WHERE id=?",
          )
          .run(time(), time(), id);
        return true;
      });
    },
    async fail(id, token, code, permanent = false) {
      return db.transaction(async () => {
        let p;
        try {
          p = await fenced(id, token);
        } catch (e) {
          if (e.mediaCode === "STALE_PROCESSING") return;
          throw e;
        }
        const terminal = permanent || p.cycle_attempts >= 4;
        await db
          .prepare(
            "UPDATE private_processing_intents SET status=?,stage=?,revision=revision+1,error_code=?,lease_token=NULL,lease_until=NULL,next_attempt_at=?,updated_at=? WHERE id=?",
          )
          .run(
            terminal ? "failed" : "pending",
            terminal ? "failed" : "pending",
            code,
            new Date(
              Date.now() + Math.min(1000 * 2 ** (p.cycle_attempts - 1), 60000),
            ).toISOString(),
            time(),
            id,
          );
        await db
          .prepare(
            "UPDATE private_media_outputs SET status='orphan',lease_until=NULL WHERE intent_id=? AND fence_token=? AND status='writing'",
          )
          .run(id, token);
      });
    },
    async release(id, token) {
      await db.transaction(async () => {
        const p = await get(id);
        if (!p) return;
        await auth.registered({ id: p.user_id }, true);
        await db
          .prepare(
            "UPDATE private_media_outputs SET lease_until=NULL WHERE intent_id=? AND fence_token=? AND status='orphan'",
          )
          .run(id, token);
        await db
          .prepare(
            "UPDATE private_processing_intents SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND status<>'processing'",
          )
          .run(id, token);
      });
    },
    async retry(principal, assetId, expected) {
      return db.transaction(async () => {
        await auth.registered(principal, true);
        await auth.creator(principal);
        const p = await db
          .prepare(
            "SELECT * FROM private_processing_intents WHERE asset_id=? AND user_id=?",
          )
          .get(assetId, principal.id);
        if (!p) throw mediaError(404, "MEDIA_NOT_FOUND", "Media not found.");
        if (
          p.revision !== expected ||
          !["failed", "ready"].includes(p.status) ||
          p.generation >= 10
        )
          throw mediaError(
            409,
            "PROCESSING_CONFLICT",
            "Refresh processing status before retrying.",
          );
        if (p.status === "ready") {
          const output = await db
            .prepare(
              "SELECT * FROM private_media_outputs WHERE intent_id=? AND status='ready'",
            )
            .get(p.id);
          let h,
            valid = false;
          try {
            if (output) {
              h = await storage.read(output.object_key);
              const sha = createHash("sha256");
              for await (const b of h.createReadStream({
                start: 0,
                autoClose: false,
              }))
                sha.update(b);
              valid =
                (await h.stat()).size === output.byte_size &&
                sha.digest("hex") === output.checksum;
            }
          } catch {
          } finally {
            await h?.close().catch(() => {});
          }
          if (valid)
            throw mediaError(
              409,
              "PROCESSING_CONFLICT",
              "Derivative is intact and already ready.",
            );
          await db
            .prepare(
              "UPDATE private_media_outputs SET status='orphan' WHERE intent_id=? AND status='ready'",
            )
            .run(p.id);
        }
        const c = await context(p);
        if (
          !c ||
          c.current_asset !== assetId ||
          c.status !== "validated" ||
          c.draft_state !== "draft" ||
          c.draft_removed ||
          c.checksum !== p.source_hash
        )
          throw mediaError(
            409,
            "PROCESSING_CONFLICT",
            "Source no longer eligible.",
          );
        await db
          .prepare(
            "UPDATE private_processing_intents SET status='pending',stage='pending',revision=revision+1,generation=generation+1,cycle_attempts=0,source_revision=?,head_revision=?,chapter_revision=?,lease_token=NULL,lease_until=NULL,next_attempt_at=?,error_code=NULL,completed_at=NULL,updated_at=? WHERE id=?",
          )
          .run(
            c.revision,
            c.head_revision,
            c.chapter_revision,
            time(),
            time(),
            p.id,
          );
        if (
          !p.outbox_id ||
          !(await db
            .prepare("SELECT id FROM background_jobs WHERE id=?")
            .get(p.outbox_id))
        ) {
          p.outbox_id = await jobQueue(db).enqueue("maintenance", {
            key: p.job_key,
            owner: p.user_id,
            payload: { intentId: p.id },
            topic: "private_audio",
          });
          await db
            .prepare(
              "UPDATE private_processing_intents SET outbox_id=? WHERE id=?",
            )
            .run(p.outbox_id, p.id);
        }
        await db
          .prepare(
            "UPDATE background_jobs SET status='pending',payload=?,attempts=0,available_at=?,completed_at=NULL,locked_by=NULL,lease_until=NULL,dispatch_topic='private_audio' WHERE id=?",
          )
          .run(JSON.stringify({ intentId: p.id }), time(), p.outbox_id);
        return processingView(await get(p.id));
      });
    },
    async reconcile() {
      const rows = await db
        .prepare(
          "SELECT id,user_id FROM private_processing_intents WHERE status IN ('pending','processing','ready') ORDER BY COALESCE(checked_at,created_at),id LIMIT 50",
        )
        .all();
      for (const item of rows)
        await db.transaction(async () => {
          await auth.registered({ id: item.user_id }, true);
          const p = await get(item.id);
          if (!p || !["pending", "processing", "ready"].includes(p.status))
            return;
          await db
            .prepare(
              "UPDATE private_processing_intents SET checked_at=? WHERE id=?",
            )
            .run(time(), p.id);
          const reason = invalid(p, await context(p));
          if (reason) {
            await retire(p, reason);
            return;
          }
          if (p.status === "ready") return;
          if (p.status === "processing" && p.lease_until > time()) return;
          if (p.status === "processing") {
            await db
              .prepare(
                "UPDATE private_media_outputs SET status='orphan' WHERE intent_id=? AND status='writing'",
              )
              .run(p.id);
            if (p.cycle_attempts >= 4) {
              await retire(p, "ATTEMPTS_EXHAUSTED");
              return;
            }
            await db
              .prepare(
                "UPDATE private_processing_intents SET status='pending',stage='pending',revision=revision+1,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?",
              )
              .run(time(), p.id);
          }
          if (p.next_attempt_at > time()) return;
          let job = p.outbox_id
            ? await db
                .prepare("SELECT * FROM background_jobs WHERE id=?")
                .get(p.outbox_id)
            : null;
          if (!job) {
            const id = await jobQueue(db).enqueue("maintenance", {
              key: p.job_key,
              owner: p.user_id,
              payload: { intentId: p.id },
              topic: "private_audio",
            });
            await db
              .prepare(
                "UPDATE private_processing_intents SET outbox_id=? WHERE id=?",
              )
              .run(id, p.id);
          } else if (
            (job.status === "completed" &&
              job.completed_at < new Date(Date.now() - 10000).toISOString()) ||
            job.status === "dead"
          )
            await db
              .prepare(
                "UPDATE background_jobs SET status='pending',attempts=0,payload=?,dispatch_topic='private_audio',available_at=?,completed_at=NULL,locked_by=NULL,lease_until=NULL WHERE id=?",
              )
              .run(JSON.stringify({ intentId: p.id }), time(), job.id);
        });
    },
    async sweep() {
      const rows = await db
        .prepare(
          "SELECT o.id,p.user_id FROM private_media_outputs o JOIN private_processing_intents p ON p.id=o.intent_id WHERE o.storage_released=0 AND o.status IN ('orphan','deleted') AND (o.lease_until IS NULL OR o.lease_until<=?) ORDER BY o.created_at,o.id LIMIT 50",
        )
        .all(time());
      for (const item of rows)
        await db.transaction(async () => {
          await auth.registered({ id: item.user_id }, true);
          const out = await db
            .prepare("SELECT * FROM private_media_outputs WHERE id=?")
            .get(item.id);
          if (
            !out ||
            out.storage_released ||
            !["orphan", "deleted"].includes(out.status) ||
            (out.lease_until && out.lease_until > time())
          )
            return;
          try {
            if (
              await db
                .prepare(
                  "SELECT id FROM private_media_assets WHERE object_key=?",
                )
                .get(out.object_key)
            )
              throw Error("ambiguous_key");
            await storage.remove(out.object_key);
            await db
              .prepare(
                "UPDATE private_media_outputs SET status='deleted',storage_released=1,cleanup_error=0 WHERE id=?",
              )
              .run(out.id);
          } catch {
            await db
              .prepare(
                "UPDATE private_media_outputs SET cleanup_error=1 WHERE id=?",
              )
              .run(out.id);
          }
        });
    },
  };
}
