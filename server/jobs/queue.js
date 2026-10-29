import { randomUUID } from "node:crypto";
export function jobQueue(db) {
  return {
    async enqueue(
      kind,
      {
        owner = null,
        payload = {},
        key = randomUUID(),
        at = new Date().toISOString(),
        maxAttempts = 5,
      } = {},
    ) {
      const id = randomUUID();
      await db
        .prepare(
          `INSERT INTO background_jobs(id,kind,dedupe_key,owner_id,payload,available_at,created_at,max_attempts) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`,
        )
        .run(
          id,
          kind,
          key,
          owner,
          JSON.stringify(payload),
          at,
          new Date().toISOString(),
          maxAttempts,
        );
      return (
        await db
          .prepare("SELECT id FROM background_jobs WHERE dedupe_key=?")
          .get(key)
      ).id;
    },
    async claim(worker, leaseMs = 30000, now = new Date()) {
      return db.transaction(async () => {
        const time = now.toISOString();
        // Expired final attempts become visible dead letters instead of stuck leases.
        await db
          .prepare(
            "UPDATE background_jobs SET status='dead',last_error='lease_expired',locked_by=NULL,lease_until=NULL WHERE status='running' AND lease_until<=? AND attempts>=max_attempts",
          )
          .run(time);
        const row = await db
          .prepare(
            `SELECT * FROM background_jobs WHERE attempts<max_attempts AND ((status='pending' AND available_at<=?) OR (status='running' AND lease_until<=?))
      ORDER BY available_at,created_at,id LIMIT 1 ${db.dialect === "postgres" ? "FOR UPDATE SKIP LOCKED" : ""}`,
          )
          .get(time, time);
        if (!row) return null;
        const lock = randomUUID();
        await db
          .prepare(
            "UPDATE background_jobs SET status='running',attempts=attempts+1,locked_by=?,lease_until=? WHERE id=?",
          )
          .run(lock, new Date(now.getTime() + leaseMs).toISOString(), row.id);
        return { ...row, attempts: row.attempts + 1, locked_by: lock, worker };
      });
    },
    async perform(job, handler) {
      // Database handlers execute in the same transaction as lease verification and
      // acknowledgement. Stale workers cannot commit DB effects after lease takeover.
      return db.transaction(async () => {
        const current = await db
          .prepare(
            `SELECT * FROM background_jobs WHERE id=? ${db.dialect === "postgres" ? "FOR UPDATE" : ""}`,
          )
          .get(job.id);
        if (
          current?.status !== "running" ||
          current.locked_by !== job.locked_by
        )
          return false;
        await handler(current);
        await db
          .prepare(
            "UPDATE background_jobs SET status='completed',completed_at=?,locked_by=NULL,lease_until=NULL,last_error=NULL,payload='{}' WHERE id=? AND locked_by=?",
          )
          .run(new Date().toISOString(), job.id, job.locked_by);
        return true;
      });
    },
    async fail(job, errorCode = "handler_failed", now = new Date()) {
      const dead = job.attempts >= job.max_attempts;
      await db
        .prepare(
          "UPDATE background_jobs SET status=?,available_at=?,last_error=?,locked_by=NULL,lease_until=NULL WHERE id=? AND status='running' AND locked_by=?",
        )
        .run(
          dead ? "dead" : "pending",
          new Date(
            now.getTime() + Math.min(1000 * 2 ** (job.attempts - 1), 60000),
          ).toISOString(),
          String(errorCode).slice(0, 80),
          job.id,
          job.locked_by,
        );
    },
  };
}
