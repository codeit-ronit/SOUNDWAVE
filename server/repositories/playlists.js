import { storySelect, serializeStory } from "../db.js";

const count =
  "(SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id=p.id) AS story_count";
export const serializePlaylist = (row) => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  storyCount: row.story_count,
});

export function playlistRepository(db) {
  return {
    list: (user, limit, cursor) =>
      db
        .prepare(
          `SELECT p.*,${count} FROM playlists p
      WHERE p.user_id=@user ${cursor ? "AND (p.created_at<@at OR (p.created_at=@at AND p.id<@id))" : ""}
      ORDER BY p.created_at DESC,p.id DESC LIMIT @limit`,
        )
        .all({
          user,
          limit,
          at: cursor?.at || "",
          id: cursor?.id || "",
        }),
    owned: (user, id, lock = false) =>
      db
        .prepare(
          `SELECT p.*,${count} FROM playlists p WHERE p.user_id=? AND p.id=?${lock && db.dialect === "postgres" ? " FOR UPDATE OF p" : ""}`,
        )
        .get(user, id),
    create: (user, id, name, at) =>
      db
        .prepare(
          "INSERT INTO playlists(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)",
        )
        .run(id, user, name, at, at),
    rename: (user, id, name, at) =>
      db
        .prepare(
          "UPDATE playlists SET name=?,updated_at=? WHERE id=? AND user_id=?",
        )
        .run(name, at, id, user),
    remove: (user, id) =>
      db
        .prepare("DELETE FROM playlists WHERE id=? AND user_id=?")
        .run(id, user),
    stories: async (user, id) =>
      (
        await db
          .prepare(
            `${storySelect} JOIN playlist_items i ON i.story_id=s.id JOIN playlists p ON p.id=i.playlist_id
      WHERE p.id=@id AND p.user_id=@user ORDER BY i.position`,
          )
          .all({ user, id })
      ).map(serializeStory),
    contains: (id, story) =>
      db
        .prepare(
          "SELECT story_id FROM playlist_items WHERE playlist_id=? AND story_id=?",
        )
        .get(id, story),
    storyExists: (story) =>
      db
        .prepare(
          "SELECT id FROM stories WHERE id=? AND ownership_kind IN ('system','external')",
        )
        .get(story),
    add: (id, story, position) =>
      db
        .prepare(
          "INSERT INTO playlist_items(playlist_id,story_id,position) VALUES(?,?,?)",
        )
        .run(id, story, position),
    advance: (user, id, at) =>
      db
        .prepare(
          "UPDATE playlists SET next_position=next_position+1,updated_at=? WHERE id=? AND user_id=?",
        )
        .run(at, id, user),
    removeStory: (id, story) =>
      db
        .prepare(
          "DELETE FROM playlist_items WHERE playlist_id=? AND story_id=?",
        )
        .run(id, story),
    touch: (user, id, at) =>
      db
        .prepare("UPDATE playlists SET updated_at=? WHERE id=? AND user_id=?")
        .run(at, id, user),
  };
}
