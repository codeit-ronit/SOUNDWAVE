import { publicStory } from "../services/publication-visibility.js";
import { storySelect, serializeStory, serializeProgress } from "../db.js";
export const sorts = Object.freeze({
  trending: "s.popularity DESC, s.id ASC",
  title: "lower(s.title) ASC, s.id ASC",
  newest: "s.id DESC",
});
const literalLike = (value) => value.replace(/[\\%_]/g, "\\$&");
export function catalogRepository(db, cache = null) {
  const repo = {
    health: () => db.prepare("SELECT 1").get(),
    story: (user, id) =>
      db.prepare(`${storySelect} WHERE s.id=@id`).get({ user, id }),
    stories: async (user, { q = "", genre = "", sort = "trending" } = {}) => {
      if (!Object.hasOwn(sorts, sort)) throw Error("Invalid repository sort");
      return (
        await db
          .prepare(
            `${storySelect} WHERE (@q='' OR lower(s.title) LIKE lower(@pattern) ESCAPE '\\' OR lower(s.genre) LIKE lower(@pattern) ESCAPE '\\')
        AND (@genre='' OR lower(s.genre)=lower(@genre)) ORDER BY ${sorts[sort]}`,
          )
          .all({
            user,
            q: q.trim(),
            pattern: `%${literalLike(q.trim())}%`,
            genre: genre.trim(),
          })
      ).map(serializeStory);
    },
    genres: async () =>
      (
        await db
          .prepare(
            `SELECT DISTINCT genre FROM stories WHERE ${publicStory("stories")} ORDER BY genre`,
          )
          .all()
      ).map((r) => r.genre),
    chapters: async (user, story) =>
      (
        await db
          .prepare(
            `SELECT c.*,COALESCE((SELECT byte_length FROM chapter_sources x WHERE x.chapter_id=c.id),(SELECT o.byte_size FROM publication_chapters pc JOIN private_media_outputs o ON o.id=pc.output_id WHERE pc.chapter_id=c.id)) AS audio_bytes,COALESCE(p.position_seconds,0) AS position_seconds,COALESCE(p.completed,0) AS completed,COALESCE(p.revision,0) AS revision,COALESCE(p.history_removed,0) AS removed
      FROM chapters c LEFT JOIN listening_progress p ON p.chapter_id=c.id AND p.user_id=? WHERE c.story_id=? AND c.draft_removed=0 AND EXISTS(SELECT 1 FROM stories s WHERE s.id=c.story_id AND ${publicStory()}) ORDER BY c.chapter_number`,
          )
          .all(user, story)
      ).map((row) => {
        const { draft_revision, draft_removed, summary, ...publicChapter } =
          row;
        return {
          ...serializeProgress(publicChapter),
          audio_url: `/api/chapters/${row.id}/stream`,
        };
      }),
    chapter: (id) =>
      db
        .prepare(
          `SELECT c.* FROM chapters c JOIN stories s ON s.id=c.story_id WHERE c.id=? AND c.draft_removed=0 AND ${publicStory()}`,
        )
        .get(id),
    library: async (user) =>
      (
        await db
          .prepare(
            `${storySelect} JOIN favorites f ON f.story_id=s.id WHERE f.user_id=@user ORDER BY f.created_at DESC,s.id DESC`,
          )
          .all({ user })
      ).map(serializeStory),
    removeFavorite: (user, id) =>
      db
        .prepare("DELETE FROM favorites WHERE user_id=? AND story_id=?")
        .run(user, id),
    progress: async (user) =>
      (
        await db
          .prepare(
            `SELECT p.*,c.story_id,c.title AS chapter_title,c.chapter_number,c.duration_seconds FROM listening_progress p JOIN chapters c ON c.id=p.chapter_id
      WHERE p.user_id=? AND p.history_removed=0 AND EXISTS(SELECT 1 FROM stories s WHERE s.id=c.story_id AND ${publicStory()}) ORDER BY p.updated_at DESC,p.chapter_id DESC`,
          )
          .all(user)
      ).map(serializeProgress),
    chapterProgress: async (user, id) =>
      serializeProgress(
        await db
          .prepare(
            "SELECT * FROM listening_progress WHERE user_id=? AND chapter_id=?",
          )
          .get(user, id),
      ),
    favoriteGenres: (user) =>
      db
        .prepare(
          "SELECT s.genre FROM favorites f JOIN stories s ON s.id=f.story_id WHERE f.user_id=?",
        )
        .all(user),
    listenedGenres: (user) =>
      db
        .prepare(
          `SELECT DISTINCT s.id,s.genre FROM listening_progress p JOIN chapters c ON c.id=p.chapter_id JOIN stories s ON s.id=c.story_id
      WHERE p.user_id=? AND (p.position_seconds>0 OR p.completed=1)`,
        )
        .all(user),
    completedStories: (user) =>
      db
        .prepare(
          `SELECT c.story_id FROM chapters c LEFT JOIN listening_progress p ON p.chapter_id=c.id AND p.user_id=?
      GROUP BY c.story_id HAVING COUNT(c.id)=SUM(COALESCE(p.completed,0))`,
        )
        .all(user),
  };
  if (cache) {
    const original = { ...repo };
    const visible = async () =>
      new Set(
        (
          await db
            .prepare(`SELECT s.id FROM stories s WHERE ${publicStory()}`)
            .all()
        ).map((r) => r.id),
      );
    const revision = async () =>
      (
        await db
          .prepare("SELECT revision FROM catalog_revision WHERE id=1")
          .get()
      ).revision;
    const favoriteIds = async (user) =>
      new Set(
        user
          ? (
              await db
                .prepare("SELECT story_id FROM favorites WHERE user_id=?")
                .all(user)
            ).map((r) => r.story_id)
          : [],
      );
    repo.stories = async (user, params = {}) => {
      const input = {
        q: (params.q || "").trim(),
        genre: (params.genre || "").trim(),
        sort: params.sort || "trending",
      };
      if (!Object.hasOwn(sorts, input.sort))
        throw Error("Invalid repository sort");
      const rows = await cache.cached(
        await revision(),
        JSON.stringify(["stories", input]),
        () => original.stories(null, input),
      );
      const favorites = await favoriteIds(user);
      const current = await visible();
      return rows
        .filter((row) => current.has(row.id))
        .map((row) => ({
          ...row,
          is_favorite: favorites.has(row.id),
        }));
    };
    repo.story = async (user, id) => {
      const row = await cache.cached(
        await revision(),
        JSON.stringify(["story", id]),
        async () => {
          const row = await original.story(null, id);
          return row ? serializeStory(row) : null;
        },
      );
      if (!row || !(await visible()).has(id)) return undefined;
      return { ...row, is_favorite: (await favoriteIds(user)).has(row.id) };
    };
    repo.genres = async () => {
      const rows = await cache.cached(
        await revision(),
        "genres",
        original.genres,
      );
      const live = new Set(await original.genres());
      return rows.filter((x) => live.has(x));
    };
  }
  return repo;
}
