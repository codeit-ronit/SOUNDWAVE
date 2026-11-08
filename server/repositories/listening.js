import { jobQueue } from "../jobs/queue.js";
import { createHash, randomUUID } from "node:crypto";
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
export function progressState(row, chapterId) {
  return {
    chapter_id: chapterId,
    position_seconds: row?.position_seconds ?? 0,
    completed: !!row?.completed,
    revision: row?.revision ?? 0,
    updated_at: row?.updated_at ?? null,
  };
}
export const progressFailure = (status, code, message, progress) =>
  Object.assign(new Error(message), {
    status,
    code,
    progress,
    progressFailure: true,
  });
export async function readProgress(db, user, chapterId) {
  return progressState(
    await db
      .prepare(
        "SELECT * FROM listening_progress WHERE user_id=? AND chapter_id=?",
      )
      .get(user, chapterId),
    chapterId,
  );
}
export async function saveProgress(
  db,
  user,
  chapter,
  {
    position,
    isComplete,
    clientId,
    sequence,
    expectedRevision,
    action = "update",
    request,
  },
) {
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        request || { position, isComplete, expectedRevision, action },
      ),
    )
    .digest("hex");
  const outcome = await db.transaction(async () => {
    await db.lockProgress?.(user, chapter.id);
    const current = await readProgress(db, user, chapter.id);
    const receipt = await db
      .prepare(
        "SELECT * FROM progress_write_versions WHERE user_id=? AND chapter_id=? AND client_id=?",
      )
      .get(user, chapter.id, clientId.toLowerCase());
    const failure = (code, message, status = 409) => ({
      failure: { code, message, status },
      progress: current,
    });
    const store = async (state, resultCode = null) =>
      db
        .prepare(
          `INSERT INTO progress_write_versions(user_id,chapter_id,client_id,sequence,request_hash,accepted_revision,ack_position,ack_completed,ack_updated_at,result_code) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,chapter_id,client_id) DO UPDATE SET sequence=excluded.sequence,request_hash=excluded.request_hash,accepted_revision=excluded.accepted_revision,ack_position=excluded.ack_position,ack_completed=excluded.ack_completed,ack_updated_at=excluded.ack_updated_at,result_code=excluded.result_code`,
        )
        .run(
          user,
          chapter.id,
          clientId.toLowerCase(),
          sequence,
          hash,
          state.revision,
          state.position_seconds,
          Number(state.completed),
          state.updated_at,
          resultCode,
        );
    if (receipt && sequence <= receipt.sequence) {
      if (sequence === receipt.sequence && receipt.request_hash === hash) {
        if (receipt.result_code)
          return failure(
            receipt.result_code,
            "This request was rejected. Choose a new write identity after refreshing progress.",
          );
        return {
          progress: current,
          acknowledgedRevision: receipt.accepted_revision,
          replayed: true,
        };
      }
      return failure(
        sequence === receipt.sequence
          ? "PROGRESS_IDENTITY_REUSED"
          : "PROGRESS_WRITE_RETIRED",
        "This write identity is reused or retired. Refresh progress before deciding how to continue.",
      );
    }
    if (
      !receipt &&
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM progress_write_versions WHERE user_id=? AND chapter_id=?",
          )
          .get(user, chapter.id)
      ).n >= 32
    )
      return failure(
        "PROGRESS_CLIENT_LIMIT",
        "This chapter has reached its 32-client write limit. Reuse an existing browser client or contact the operator.",
        429,
      );
    const reject = async (code, message) => {
      await store(current, code);
      return failure(code, message);
    };
    if (expectedRevision !== current.revision)
      return reject(
        "PROGRESS_CONFLICT",
        "Another session saved this chapter. Choose which position to keep.",
      );
    if (current.completed && !isComplete && action !== "reset")
      return reject(
        "PROGRESS_RESET_REQUIRED",
        "Reopening a completed chapter requires an explicit reset.",
      );
    if (current.revision >= Number.MAX_SAFE_INTEGER)
      return reject(
        "PROGRESS_REVISION_LIMIT",
        "Progress revision limit reached.",
      );
    const changed =
      action === "reset" ||
      current.updated_at === null ||
      current.position_seconds !==
        (isComplete ? chapter.duration_seconds : position) ||
      current.completed !== isComplete;
    const revision = current.revision + Number(changed);
    if (changed)
      await db
        .prepare(
          `INSERT INTO listening_progress(user_id,chapter_id,position_seconds,completed,revision) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id,chapter_id) DO UPDATE SET position_seconds=excluded.position_seconds,completed=excluded.completed,revision=excluded.revision,updated_at=${db.now}`,
        )
        .run(
          user,
          chapter.id,
          isComplete ? chapter.duration_seconds : position,
          Number(isComplete),
          revision,
        );
    const saved = await readProgress(db, user, chapter.id);
    await store(saved);
    if (isComplete && !current.completed)
      await recordEvent(db, {
        user,
        type: "chapter_completed",
        storyId: chapter.story_id,
        chapterId: chapter.id,
      });
    return { progress: saved, acknowledgedRevision: revision, replayed: false };
  });
  if (outcome.failure)
    throw progressFailure(
      outcome.failure.status,
      outcome.failure.code,
      outcome.failure.message,
      outcome.progress,
    );
  return outcome;
}
