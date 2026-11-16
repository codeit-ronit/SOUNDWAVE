import { historyRepository } from "../repositories/history.js";
import { lockHistoryOwner } from "../repositories/history-owner.js";
import { progressFailure } from "../repositories/progress-error.js";
// Re-exported here for a single route/service entry point.
export const invalidHistory = (message) =>
  progressFailure(400, "INVALID_HISTORY_REQUEST", message);
export function historyPagination(query, user) {
  if (Object.keys(query).some((k) => !["limit", "cursor"].includes(k)))
    throw invalidHistory("Only limit and cursor are supported.");
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (
    (query.limit !== undefined &&
      (typeof query.limit !== "string" || !/^[1-9]\d?$/.test(query.limit))) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw invalidHistory("limit must be an integer from 1 to 50.");
  let cursor;
  if (query.cursor !== undefined)
    try {
      if (
        typeof query.cursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,512}$/.test(query.cursor)
      )
        throw Error();
      const bytes = Buffer.from(query.cursor, "base64url");
      if (bytes.toString("base64url") !== query.cursor) throw Error();
      cursor = JSON.parse(bytes.toString());
      if (
        !cursor ||
        Object.keys(cursor).length !== 4 ||
        cursor.v !== 1 ||
        cursor.owner !== user ||
        !Number.isSafeInteger(cursor.chapter) ||
        cursor.chapter < 1 ||
        cursor.chapter > 999999999 ||
        typeof cursor.at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(cursor.at) ||
        new Date(cursor.at).toISOString().slice(0, 19) !==
          cursor.at.slice(0, 19)
      )
        throw Error();
    } catch {
      throw invalidHistory("Invalid history cursor.");
    }
  return { limit, cursor };
}
export function historyService(db) {
  const repo = historyRepository(db);
  return {
    ...repo,
    list: (user, limit, cursor) =>
      db.transaction(async () => {
        const owner = await lockHistoryOwner(db, user),
          rows = await repo.list(user, limit, cursor),
          page = rows.slice(0, limit),
          last = page.at(-1);
        return {
          entries: page.map(
            ({
              cursor_time,
              story_color,
              story_symbol,
              story_genre,
              ...row
            }) => ({
              ...row,
              story: {
                id: row.story_id,
                title: row.story_title,
                color: story_color,
                symbol: story_symbol,
                genre: story_genre,
              },
              completed: !!row.completed,
            }),
          ),
          nextCursor:
            rows.length > limit
              ? Buffer.from(
                  JSON.stringify({
                    v: 1,
                    owner: user,
                    at: last.cursor_time,
                    chapter: last.chapter_id,
                  }),
                ).toString("base64url")
              : null,
          historyRevision: owner.history_revision,
        };
      }),
  };
}
