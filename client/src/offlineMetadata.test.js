import { it, expect } from "vitest";
import { publicStory, publicChapter } from "./offlineMetadata";
it("removes personalized state and unexpected identity fields from offline metadata", () => {
  expect(
    publicStory({
      id: 1,
      title: "Story",
      is_favorite: true,
      resume_chapter_id: 101,
      position_seconds: 8,
      user_id: "alice",
      recommendation_reason: "Because you like mystery",
      csrfToken: "secret",
    }),
  ).toEqual({ id: 1, title: "Story", is_favorite: false });
  expect(
    publicChapter({
      id: 101,
      audio_url: "/api/chapters/101/stream",
      position_seconds: 18,
      completed: true,
      user_id: "alice",
      updated_at: "private",
    }),
  ).toEqual({
    id: 101,
    audio_url: "/api/chapters/101/stream",
    position_seconds: 0,
    completed: false,
  });
});
