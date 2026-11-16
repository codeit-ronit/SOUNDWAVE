import { Router } from "express";
import { requireUser } from "../middleware/auth.js";
import { authorizationService } from "../services/authorization.js";
import { telemetry } from "../telemetry.js";
export async function diagnostics(db, redis, config) {
  const jobs = await db
    .prepare(
      "SELECT kind,status,COUNT(*) AS count,MIN(created_at) AS oldest FROM background_jobs GROUP BY kind,status",
    )
    .all();
  const processing = await db
    .prepare(
      "SELECT status,COUNT(*) AS count,SUM(attempts) AS attempts,MIN(created_at) AS oldest FROM private_processing_intents GROUP BY status",
    )
    .all();
  const storage = await db
    .prepare(
      "SELECT COALESCE(SUM(reserved_bytes),0) AS reserved,COALESCE(SUM(CASE WHEN cleanup_error<>0 THEN 1 ELSE 0 END),0) AS cleanup_errors FROM private_media_assets WHERE storage_released=0",
    )
    .get();
  const outputs = await db
    .prepare(
      "SELECT COALESCE(SUM(reserved_bytes),0) AS reserved,COALESCE(SUM(CASE WHEN status='orphan' THEN reserved_bytes ELSE 0 END),0) AS orphan_bytes,COALESCE(SUM(cleanup_error),0) AS cleanup_errors FROM private_media_outputs WHERE storage_released=0",
    )
    .get();
  const creators = (
    await db.prepare("SELECT COUNT(*) AS count FROM creator_profiles").get()
  ).count;
  return {
    metrics: telemetry(db).snapshot(),
    pool: db.pool
      ? {
          total: db.pool.totalCount,
          idle: db.pool.idleCount,
          waiting: db.pool.waitingCount,
        }
      : null,
    cache: redis?.cacheStats?.() || null,
    backlog: {
      outbox: jobs.map((r) => ({
        ...r,
        oldestAgeSeconds: r.oldest
          ? Math.max(0, (Date.now() - Date.parse(r.oldest)) / 1000)
          : 0,
      })),
      processing: processing.map((r) => ({
        ...r,
        oldestAgeSeconds: r.oldest
          ? Math.max(0, (Date.now() - Date.parse(r.oldest)) / 1000)
          : 0,
      })),
    },
    storage: {
      sourceReservedBytes: Number(storage.reserved),
      outputReservedBytes: Number(outputs.reserved),
      orphanBytes: Number(outputs.orphan_bytes),
      cleanupErrors:
        Number(storage.cleanup_errors) + Number(outputs.cleanup_errors),
      creatorCount: creators,
      quotaCapacityBytes: config ? creators * config.creatorStorageBytes : null,
      quotaUtilization:
        config && creators
          ? (Number(storage.reserved) + Number(outputs.reserved)) /
            (creators * config.creatorStorageBytes)
          : null,
    },
    memory: {
      rss: process.memoryUsage().rss,
      heapUsed: process.memoryUsage().heapUsed,
    },
  };
}
export function diagnosticsRouter(db, redis, config) {
  const r = Router();
  r.get("/internal/diagnostics", requireUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      await authorizationService(db).staff(req.user, ["admin"]);
      if (Object.keys(req.query).length)
        return res
          .status(400)
          .json({ error: { message: "No diagnostic selectors accepted." } });
      res.json(await diagnostics(db, redis, config));
    } catch (e) {
      if (e.permissionCode)
        return res
          .status(e.status)
          .json({ error: { code: e.permissionCode, message: e.message } });
      throw e;
    }
  });
  return r;
}
