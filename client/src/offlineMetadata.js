// Downloads contain public catalog metadata, never another account's saved state.
const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((k) => value[k] !== undefined).map((k) => [k, value[k]]),
  );
export const publicStory = (story) => ({
  ...pick(story, [
    "id",
    "title",
    "genre",
    "author",
    "tagline",
    "description",
    "color",
    "symbol",
    "popularity",
    "chapter_count",
    "duration_seconds",
  ]),
  is_favorite: false,
});
export const publicChapter = (chapter) => ({
  ...pick(chapter, [
    "id",
    "story_id",
    "chapter_number",
    "title",
    "audio_url",
    "duration_seconds",
  ]),
  position_seconds: 0,
  completed: false,
});
