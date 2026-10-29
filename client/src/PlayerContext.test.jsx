import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { PlayerProvider, usePlayer } from "./PlayerContext";
import { api } from "./api";
vi.mock("./api", () => ({
  api: { progress: vi.fn(), chapters: vi.fn(), save: vi.fn() },
}));
const story = { id: 1, title: "Test story" };
const chapters = [
  {
    id: 101,
    chapter_number: 1,
    title: "One",
    audio_url: "/audio/1-1.wav",
    duration_seconds: 30,
    position_seconds: 0,
    completed: false,
  },
  {
    id: 102,
    chapter_number: 2,
    title: "Two",
    audio_url: "/audio/1-2.wav",
    duration_seconds: 30,
    position_seconds: 0,
    completed: false,
  },
];
let player;
function Probe() {
  player = usePlayer();
  return <span>{player.active?.chapter.title}</span>;
}
function setup() {
  const result = render(
    <PlayerProvider>
      <Probe />
    </PlayerProvider>,
  );
  return { ...result, audio: result.container.querySelector("audio") };
}
beforeEach(() => {
  vi.clearAllMocks();
  api.progress.mockResolvedValue({ progress: [], continueListening: [] });
  api.chapters.mockResolvedValue({ chapters });
  api.save.mockResolvedValue({});
  const paused = new WeakMap();
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(1);
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(30);
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(
    function () {
      return paused.get(this) ?? true;
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function () {
    this.dispatchEvent(new Event("loadedmetadata"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function () {
    paused.set(this, false);
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function () {
    if (paused.get(this) === false) {
      paused.set(this, true);
      this.dispatchEvent(new Event("pause"));
    }
  });
});
afterEach(cleanup);
describe("persistent audio player", () => {
  it("restores server progress after mounting without autoplay", async () => {
    api.progress.mockResolvedValue({
      progress: [],
      continueListening: [{ ...story, resume_chapter_id: 101 }],
    });
    api.chapters.mockResolvedValue({
      chapters: [{ ...chapters[0], position_seconds: 12.5 }, chapters[1]],
    });
    const { audio } = setup();
    await waitFor(() => expect(player.active?.chapter.id).toBe(101));
    expect(audio.currentTime).toBe(12.5);
    expect(player.playing).toBe(false);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(audio.volume).toBe(0.8);
  });
  it("saves pause and seek snapshots and preserves the previous chapter on transition", async () => {
    const { audio } = setup();
    await act(async () => player.playStory(story));
    await act(async () => {
      audio.currentTime = 9;
      player.toggle();
    });
    expect(api.save).toHaveBeenCalledWith(101, 9, false, false);
    await act(async () => player.seek(14));
    expect(api.save).toHaveBeenLastCalledWith(101, 14, false, false);
    await act(async () => player.move(1));
    expect(player.active.chapter.id).toBe(102);
    expect(api.save.mock.calls.some((c) => c[0] === 101 && c[1] === 14)).toBe(
      true,
    );
  });
  it("autosaves after approximately ten seconds and saves on pagehide", async () => {
    const { audio } = setup();
    await act(async () => player.playStory(story));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11000);
    await act(async () => {
      audio.currentTime = 11;
      audio.dispatchEvent(new Event("timeupdate"));
    });
    expect(api.save).toHaveBeenCalledWith(101, 11, false, false);
    await act(async () => {
      audio.currentTime = 12;
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(api.save).toHaveBeenCalledWith(101, 12, false, true);
  });
  it("marks the finished chapter complete before automatically advancing", async () => {
    const { audio } = setup();
    await act(async () => player.playStory(story));
    await act(async () => {
      audio.currentTime = 30;
      audio.dispatchEvent(new Event("ended"));
    });
    expect(api.save).toHaveBeenCalledWith(101, 30, true, false);
    expect(player.active.chapter.id).toBe(102);
    expect(player.playing).toBe(true);
  });
  it("explains autoplay restrictions and allows a user retry", async () => {
    HTMLMediaElement.prototype.play.mockRejectedValueOnce(
      new DOMException("Blocked", "NotAllowedError"),
    );
    setup();
    await act(async () => player.playStory(story));
    expect(player.error).toMatch(/Press play/);
    expect(player.playing).toBe(false);
    await act(async () => player.toggle());
    expect(player.playing).toBe(true);
    expect(player.error).toBe("");
  });
  it("shows persistence failures and clears the message after retry", async () => {
    const { audio } = setup();
    await act(async () => player.playStory(story));
    api.save.mockRejectedValueOnce(new Error("Offline"));
    await act(async () => {
      audio.currentTime = 4;
      player.toggle();
    });
    expect(player.saveError).toMatch(/Offline/);
    await act(async () => player.retrySave());
    expect(player.saveError).toBe("");
  });
  it("ignores an older chapter request when the user changes stories quickly", async () => {
    let resolveOld;
    api.chapters
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValueOnce({ chapters: [{ ...chapters[0], id: 201 }] });
    setup();
    let old;
    await act(async () => {
      old = player.playStory(story);
      await Promise.resolve();
    });
    await act(async () => player.playStory({ id: 2, title: "Second" }));
    await act(async () => {
      resolveOld({ chapters });
      await old;
    });
    expect(player.active.story.id).toBe(2);
    expect(player.active.chapter.id).toBe(201);
  });
});
