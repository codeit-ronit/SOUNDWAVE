import { jobQueue } from "../jobs/queue.js";
import { randomUUID } from "node:crypto";
export async function recordEvent(
  db,
  {
    user,
    id = randomUUID(),
    type,
    storyId,
    chapterId = null,
    listeningSeconds = 0,
    playbackRate = 1,
  },
) {
  return db.transaction(async () => {
    const result = await db
      .prepare(
        `INSERT INTO listening_events(event_id,user_id,story_id,chapter_id,event_type,listening_seconds,metadata)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,event_id) DO NOTHING`,
      )
      .run(
        id,
        user,
        storyId,
        chapterId,
        type,
        listeningSeconds,
        JSON.stringify({ playbackRate }),
      );
    if (result.changes) {
      const stored = await db
        .prepare(
          "SELECT created_at FROM listening_events WHERE user_id=? AND event_id=?",
        )
        .get(user, id);
      await jobQueue(db).enqueue("analytics_rollup", {
        owner: user,
        payload: { day: stored.created_at.slice(0, 10) },
        key: `event:${user}:${id}`,
      });
    }
    return result;
  });
}
export async function saveFavorite(db, user, storyId) {
  await db.transaction(async () => {
    const inserted = await db
      .prepare(
        "INSERT INTO favorites(user_id,story_id) VALUES(?,?) ON CONFLICT DO NOTHING",
      )
      .run(user, storyId);
    if (inserted.changes)
      await recordEvent(db, { user, type: "story_favorited", storyId });
  });
}
export async function saveProgress(
  db,
  user,
  chapter,
  { position, isComplete, clientId, sequence },
) {
  await db.transaction(async () => {
    await db.lockProgress?.(user, chapter.id);
    if (clientId) {
      const result = await db
        .prepare(
          `INSERT INTO progress_write_versions(user_id,chapter_id,client_id,sequence) VALUES(?,?,?,?)
        ON CONFLICT(user_id,chapter_id,client_id) DO UPDATE SET sequence=excluded.sequence
        WHERE progress_write_versions.sequence<excluded.sequence`,
        )
        .run(user, chapter.id, clientId.toLowerCase(), sequence);
      if (!result.changes) return;
    }
    const previous = await db
      .prepare(
        "SELECT completed FROM listening_progress WHERE user_id=? AND chapter_id=?",
      )
      .get(user, chapter.id);
    await db
      .prepare(
        `INSERT INTO listening_progress(user_id,chapter_id,position_seconds,completed) VALUES(?,?,?,?)
      ON CONFLICT(user_id,chapter_id) DO UPDATE SET position_seconds=excluded.position_seconds,completed=excluded.completed,updated_at=${db.now}`,
      )
      .run(
        user,
        chapter.id,
        isComplete ? chapter.duration_seconds : position,
        Number(isComplete),
      );
    if (isComplete && !previous?.completed)
      await recordEvent(db, {
        user,
        type: "chapter_completed",
        storyId: chapter.story_id,
        chapterId: chapter.id,
      });
  });
}
