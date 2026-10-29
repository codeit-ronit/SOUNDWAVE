export function jobHandlers(db, { mail } = {}) {
  return {
    async analytics_rollup(job) {
      const { day } = JSON.parse(job.payload);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !job.owner_id)
        throw Object.assign(Error("Invalid rollup"), {
          code: "invalid_rollup",
        });
      // Serialize rebuilding a user's daily snapshot across workers. Recalculation,
      // never increments, makes retries and late events deterministic.
      await db.lockProgress?.(job.owner_id, `rollup:${day}`);
      await db
        .prepare("DELETE FROM analytics_rollups WHERE user_id=? AND day=?")
        .run(job.owner_id, day);
      const end = new Date(
        new Date(day + "T00:00:00.000Z").getTime() + 86400000,
      ).toISOString();
      const rows = await db
        .prepare(
          `SELECT s.genre,SUM(e.listening_seconds) AS seconds,COUNT(*) AS count FROM listening_events e JOIN stories s ON s.id=e.story_id
    WHERE e.user_id=? AND e.created_at>=? AND e.created_at<? AND e.listening_seconds>0 GROUP BY s.genre`,
        )
        .all(job.owner_id, day + "T00:00:00.000Z", end);
      for (const row of rows)
        await db
          .prepare(
            "INSERT INTO analytics_rollups(user_id,day,genre,listening_seconds,interval_count,updated_at) VALUES(?,?,?,?,?,?)",
          )
          .run(
            job.owner_id,
            day,
            row.genre,
            row.seconds,
            row.count,
            new Date().toISOString(),
          );
    },
    async maintenance() {
      const now = new Date(),
        expired = new Date(now.getTime() - 7 * 86400000).toISOString();
      // Bounded batches avoid long table locks; registered/legacy identities are never removed.
      await db
        .prepare(
          "DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at<=? LIMIT 500)",
        )
        .run(now.toISOString());
      const guests = await db
        .prepare(
          `SELECT u.id FROM users u WHERE u.kind='guest' AND u.created_at<? AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.expires_at>?) AND NOT EXISTS(SELECT 1 FROM background_jobs j WHERE j.owner_id=u.id AND j.status='running') ORDER BY u.id LIMIT 100 ${db.dialect === "postgres" ? "FOR UPDATE OF u SKIP LOCKED" : ""}`,
        )
        .all(expired, now.toISOString());
      for (const { id } of guests) {
        // Recheck under the user row lock before removing a guest that may be upgrading.
        for (const table of [
          "background_jobs",
          "analytics_rollups",
          "listening_events",
          "progress_write_versions",
          "listening_progress",
          "favorites",
          "sessions",
          "account_tokens",
        ]) {
          if (table === "background_jobs")
            await db
              .prepare("DELETE FROM background_jobs WHERE owner_id=?")
              .run(id);
          else await db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id);
        }
        await db
          .prepare("DELETE FROM users WHERE id=? AND kind='guest'")
          .run(id);
      }
      await db
        .prepare(
          "DELETE FROM account_tokens WHERE token_hash IN (SELECT token_hash FROM account_tokens WHERE expires_at<? LIMIT 500)",
        )
        .run(expired);
      const retention = new Date(now.getTime() - 30 * 86400000).toISOString();
      await db
        .prepare(
          "DELETE FROM background_jobs WHERE id IN (SELECT id FROM background_jobs WHERE status='completed' AND completed_at<? LIMIT 500)",
        )
        .run(retention);
      // Failed jobs keep diagnostics but never retain encrypted delivery payloads indefinitely.
      await db
        .prepare(
          "UPDATE background_jobs SET payload='{}' WHERE id IN (SELECT id FROM background_jobs WHERE status='dead' AND created_at<? LIMIT 500)",
        )
        .run(expired);
    },
    async send_email(job) {
      if (!mail)
        throw Object.assign(Error("Email transport unavailable"), {
          code: "mail_unavailable",
        });
      const hash = job.dedupe_key?.startsWith("account-token:")
        ? job.dedupe_key.slice(14)
        : null;
      if (hash) {
        const token = await db
          .prepare(
            "SELECT consumed_at,expires_at FROM account_tokens WHERE token_hash=?",
          )
          .get(hash);
        if (
          !token ||
          token.consumed_at ||
          token.expires_at <= new Date().toISOString()
        )
          return;
      }
      await mail.send(job.id, JSON.parse(job.payload));
    },
  };
}
