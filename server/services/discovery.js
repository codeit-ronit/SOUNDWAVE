import { serializeStory } from "../db.js";
export async function listeningHistory(repo, user) {
  const progress = await repo.progress(user);
  const latest = new Map();
  for (const row of progress)
    if (!latest.has(row.story_id)) latest.set(row.story_id, row);
  const continueListening = [];
  for (const row of latest.values()) {
    const chapters = await repo.chapters(user, row.story_id);
    const current = chapters.find((c) => c.id === row.chapter_id);
    const next = current.completed
      ? chapters.find(
          (c) => c.chapter_number > current.chapter_number && !c.completed,
        ) || chapters.find((c) => !c.completed)
      : current;
    if (next)
      continueListening.push({
        ...serializeStory(await repo.story(user, row.story_id)),
        resume_chapter_id: next.id,
        chapter_title: next.title,
        chapter_number: next.chapter_number,
        position_seconds: next.position_seconds,
        chapter_duration_seconds: next.duration_seconds,
        updated_at: row.updated_at,
      });
  }
  return { progress, continueListening };
}
export async function recommendations(repo, user) {
  const weights = new Map();
  const add = (genre, n) => weights.set(genre, (weights.get(genre) || 0) + n);
  for (const row of await repo.favoriteGenres(user)) add(row.genre, 4);
  for (const row of await repo.listenedGenres(user)) add(row.genre, 2);
  const completed = new Set(
    (await repo.completedStories(user)).map((r) => r.story_id),
  );
  const stories = (await repo.stories(user))
    .filter((s) => !s.is_favorite && !completed.has(s.id))
    .map((s) => ({
      ...s,
      recommendation_score: weights.get(s.genre) || 0,
      recommendation_reason: weights.get(s.genre)
        ? `Because you listen to ${s.genre.toLowerCase()}`
        : "Popular on SoundWave",
    }))
    .sort(
      (a, b) =>
        b.recommendation_score - a.recommendation_score ||
        b.popularity - a.popularity ||
        a.id - b.id,
    )
    .slice(0, 4);
  return { strategy: "rule-based", stories };
}
