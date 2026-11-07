import { randomUUID } from "node:crypto";
import {
  playlistRepository,
  serializePlaylist,
} from "../repositories/playlists.js";

export const playlistError = (status, code, message) =>
  Object.assign(new Error(message), { status, playlistCode: code });
export function playlistService(db) {
  const repo = playlistRepository(db);
  const owned = async (user, id) => {
    const row = await repo.owned(user, id, true);
    if (!row)
      throw playlistError(404, "PLAYLIST_NOT_FOUND", "Playlist not found.");
    // Read the count in a NEW statement after any lock wait. A correlated count
    // in SELECT FOR UPDATE can otherwise use its pre-wait READ COMMITTED snapshot.
    return repo.owned(user, id);
  };
  return {
    async list(user, limit, cursor) {
      const rows = await repo.list(user, limit + 1, cursor);
      const page = rows.slice(0, limit),
        last = page.at(-1);
      return {
        playlists: page.map(serializePlaylist),
        nextCursor:
          rows.length > limit
            ? Buffer.from(
                JSON.stringify({ at: last.created_at, id: last.id }),
              ).toString("base64url")
            : null,
      };
    },
    async create(user, name) {
      return db.transaction(async () => {
        const id = randomUUID();
        await repo.create(user, id, name, new Date().toISOString());
        return serializePlaylist(await owned(user, id));
      });
    },
    detail: (user, id) =>
      db.transaction(async () => ({
        playlist: serializePlaylist(await owned(user, id)),
        stories: await repo.stories(user, id),
      })),
    rename: (user, id, name) =>
      db.transaction(async () => {
        await owned(user, id);
        await repo.rename(user, id, name, new Date().toISOString());
        return serializePlaylist(await owned(user, id));
      }),
    remove: (user, id) =>
      db.transaction(async () => {
        await owned(user, id);
        await repo.remove(user, id);
      }),
    add: (user, id, story) =>
      db.transaction(async () => {
        // One parent lock serializes capacity, membership and order across API instances.
        const row = await owned(user, id);
        if (!(await repo.storyExists(story)))
          throw playlistError(404, "STORY_NOT_FOUND", "Story not found.");
        if (await repo.contains(id, story)) return serializePlaylist(row);
        if (row.story_count >= 100)
          throw playlistError(
            409,
            "PLAYLIST_FULL",
            "A playlist can contain at most 100 stories.",
          );
        if (row.next_position >= Number.MAX_SAFE_INTEGER)
          throw playlistError(
            409,
            "PLAYLIST_ORDER_LIMIT",
            "This playlist cannot accept more additions.",
          );
        await repo.add(id, story, row.next_position);
        await repo.advance(user, id, new Date().toISOString());
        return serializePlaylist(await owned(user, id));
      }),
    removeStory: (user, id, story) =>
      db.transaction(async () => {
        await owned(user, id);
        if ((await repo.removeStory(id, story)).changes)
          await repo.touch(user, id, new Date().toISOString());
      }),
  };
}
