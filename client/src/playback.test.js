import { describe, expect, it } from "vitest";
import { timeLabel, resumeChapter, resumePosition } from "./playback";
describe("playback selection", () => {
  const chapters = [
    { id: 1, duration_seconds: 30, position_seconds: 30, completed: true },
    { id: 2, duration_seconds: 40, position_seconds: 12, completed: false },
  ];
  it("resumes the unfinished chapter and retains fractional progress", () => {
    expect(resumeChapter(chapters).id).toBe(2);
    expect(resumePosition({ ...chapters[1], position_seconds: 12.5 })).toBe(
      12.5,
    );
  });
  it("advances to the first unfinished chapter after completion", () => {
    expect(
      resumeChapter([chapters[0], { ...chapters[1], position_seconds: 0 }]).id,
    ).toBe(2);
  });
  it("restarts from chapter one when the story is complete", () => {
    const completed = chapters.map((c) => ({ ...c, completed: true }));
    expect(resumeChapter(completed).id).toBe(1);
    expect(resumePosition(completed[0])).toBe(0);
  });
  it("bounds restored positions and formats times", () => {
    expect(resumePosition({ ...chapters[1], position_seconds: 999 })).toBe(40);
    expect(timeLabel(65.4)).toBe("1:05");
    expect(timeLabel(Infinity)).toBe("0:00");
  });
});
