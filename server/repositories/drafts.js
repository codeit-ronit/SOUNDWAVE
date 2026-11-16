export const storyDraft = (row) => ({
  id: row.id,
  title: row.title,
  description: row.description,
  genre: row.genre,
  language: row.language,
  state: row.draft_state,
  revision: row.draft_revision,
});
export const chapterDraft = (row) => ({
  id: row.id,
  title: row.title,
  summary: row.summary,
  position: row.draft_removed ? null : row.chapter_number,
  revision: row.draft_revision,
  removed: !!row.draft_removed,
});
export function draftRepository(db) {
  return {
    story: (id) => db.prepare("SELECT * FROM stories WHERE id=?").get(id),
    chapter: (story, id) =>
      db
        .prepare("SELECT * FROM chapters WHERE story_id=? AND id=?")
        .get(story, id),
    chapters: (id) =>
      db
        .prepare(
          "SELECT * FROM chapters WHERE story_id=? AND draft_removed=0 ORDER BY chapter_number,id LIMIT 101",
        )
        .all(id),
    countStories: (owner) =>
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM stories WHERE owner_id=? AND ownership_kind='creator'",
        )
        .get(owner),
    countChapters: (id) =>
      db.prepare("SELECT COUNT(*) AS n FROM chapters WHERE story_id=?").get(id),
    list: (owner, limit, before) =>
      db
        .prepare(
          `SELECT * FROM stories WHERE owner_id=? AND ownership_kind='creator' ${before ? "AND id<?" : ""} ORDER BY id DESC LIMIT ?`,
        )
        .all(owner, ...(before ? [before] : []), limit + 1),
    receipt: (owner, key) =>
      db
        .prepare(
          "SELECT * FROM draft_create_receipts WHERE user_id=? AND request_id=?",
        )
        .get(owner, key.toLowerCase()),
    saveReceipt: (owner, key, hash, kind, story, chapter = null) =>
      db
        .prepare(
          "INSERT INTO draft_create_receipts(user_id,request_id,request_hash,kind,story_id,chapter_id) VALUES(?,?,?,?,?,?)",
        )
        .run(owner, key.toLowerCase(), hash, kind, story, chapter),
    async allocate(kind) {
      const table = kind === "story" ? "stories" : "chapters";
      const row = await db
        .prepare(
          `SELECT next_id FROM creator_id_allocations WHERE kind=?${db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
        )
        .get(kind);
      const max =
        (
          await db
            .prepare(
              `SELECT MAX(id) AS n FROM ${table} WHERE id BETWEEN 900000000 AND 999999999`,
            )
            .get()
        ).n ?? 899999999;
      const id = Math.max(row.next_id, max + 1);
      if (id > 999999999) return null;
      await db
        .prepare("UPDATE creator_id_allocations SET next_id=? WHERE kind=?")
        .run(id + 1, kind);
      return id;
    },
  };
}
