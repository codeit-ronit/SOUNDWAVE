import { publicStory } from "../services/publication-visibility.js";
import { progressFailure, readProgress } from "./listening.js";
import {
  lockHistoryOwner,
  advanceHistory,
  historyNow,
} from "./history-owner.js";
export function historyRepository(db) {
  return {
    list: (user, limit, cursor) =>
      db
        .prepare(
          `SELECT p.chapter_id,p.position_seconds,p.completed,p.revision,p.updated_at,c.title AS chapter_title,c.chapter_number,c.duration_seconds,c.story_id,s.title AS story_title,s.color AS story_color,s.symbol AS story_symbol,s.genre AS story_genre,
    ${db.dialect === "postgres" ? `to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` : "p.updated_at"} AS cursor_time
    FROM listening_progress p JOIN chapters c ON c.id=p.chapter_id JOIN stories s ON s.id=c.story_id
    WHERE p.user_id=? AND p.history_removed=0 AND ${publicStory()} ${cursor ? "AND (p.updated_at<? OR (p.updated_at=? AND p.chapter_id<?))" : ""}
    ORDER BY p.updated_at DESC,p.chapter_id DESC LIMIT ?`,
        )
        .all(
          user,
          ...(cursor ? [cursor.at, cursor.at, cursor.chapter] : []),
          limit + 1,
        ),
    async remove(user, chapter, expected) {
      return db.transaction(async () => {
        const owner = await lockHistoryOwner(db, user);
        await db.lockProgress?.(user, chapter);
        const row = await db
          .prepare(
            "SELECT * FROM listening_progress WHERE user_id=? AND chapter_id=?",
          )
          .get(user, chapter);
        if (!row || row.history_removed)
          return {
            removed: true,
            historyRevision: owner.history_revision,
            progress: row ? await readProgress(db, user, chapter) : null,
          };
        if (row.revision !== expected)
          throw progressFailure(
            409,
            "PROGRESS_CONFLICT",
            "Saved history changed. Refresh before removing this chapter.",
            await readProgress(db, user, chapter),
          );
        if (row.revision >= Number.MAX_SAFE_INTEGER)
          throw progressFailure(
            409,
            "PROGRESS_REVISION_LIMIT",
            "Progress revision limit reached.",
            await readProgress(db, user, chapter),
          );
        await db
          .prepare(
            `UPDATE listening_progress SET history_removed=1,position_seconds=CASE WHEN completed=1 THEN position_seconds ELSE 0 END,revision=revision+1,updated_at=${historyNow(db)} WHERE user_id=? AND chapter_id=?`,
          )
          .run(user, chapter);
        return {
          removed: true,
          historyRevision: await advanceHistory(db, user),
          progress: await readProgress(db, user, chapter),
        };
      });
    },
    clear: (user, expected) =>
      db.transaction(async () => {
        const owner = await lockHistoryOwner(db, user),
          count = (
            await db
              .prepare(
                "SELECT COUNT(*) AS n FROM listening_progress WHERE user_id=? AND history_removed=0",
              )
              .get(user)
          ).n;
        if (!count)
          return {
            cleared: true,
            removedCount: 0,
            historyRevision: owner.history_revision,
          };
        if (owner.history_revision !== expected)
          throw Object.assign(
            progressFailure(
              409,
              "HISTORY_CHANGED",
              "History changed. Refresh and confirm again.",
            ),
            { historyRevision: owner.history_revision },
          );
        if (
          (
            await db
              .prepare(
                "SELECT COUNT(*) AS n FROM listening_progress WHERE user_id=? AND history_removed=0 AND revision>=?",
              )
              .get(user, Number.MAX_SAFE_INTEGER)
          ).n
        )
          throw progressFailure(
            409,
            "PROGRESS_REVISION_LIMIT",
            "Progress revision limit reached.",
          );
        await db
          .prepare(
            `UPDATE listening_progress SET history_removed=1,position_seconds=CASE WHEN completed=1 THEN position_seconds ELSE 0 END,revision=revision+1,updated_at=${historyNow(db)} WHERE user_id=? AND history_removed=0`,
          )
          .run(user);
        return {
          cleared: true,
          removedCount: count,
          historyRevision: await advanceHistory(db, user),
        };
      }),
  };
}
