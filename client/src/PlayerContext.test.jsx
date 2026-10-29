import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { PlayerProvider, usePlayer } from "./PlayerContext";
import { api } from "./api";
vi.mock("./api", () => ({
  api: {
    progress: vi.fn(),
    chapters: vi.fn(),
    save: vi.fn(),
    analyticsEvent: vi.fn(),
  },
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
  api.analyticsEvent.mockResolvedValue({});
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
    expect(api.save).toHaveBeenCalledWith(
      101,
      9,
      false,
      false,
      expect.objectContaining({
        clientId: expect.any(String),
        sequence: expect.any(Number),
      }),
    );
    await act(async () => player.seek(14));
    await waitFor(() =>
      expect(api.save).toHaveBeenLastCalledWith(
        101,
        14,
        false,
        false,
        expect.objectContaining({
          clientId: expect.any(String),
          sequence: expect.any(Number),
        }),
      ),
    );
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
    expect(api.save).toHaveBeenCalledWith(
      101,
      11,
      false,
      false,
      expect.objectContaining({
        clientId: expect.any(String),
        sequence: expect.any(Number),
      }),
    );
    await act(async () => {
      audio.currentTime = 12;
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(api.save).toHaveBeenCalledWith(
      101,
      12,
      false,
      true,
      expect.objectContaining({
        clientId: expect.any(String),
        sequence: expect.any(Number),
      }),
    );
  });
  it("marks the finished chapter complete before automatically advancing", async () => {
    const { audio } = setup();
    await act(async () => player.playStory(story));
    await act(async () => {
      audio.currentTime = 30;
      audio.dispatchEvent(new Event("ended"));
    });
    expect(api.save).toHaveBeenCalledWith(
      101,
      30,
      true,
      false,
      expect.objectContaining({
        clientId: expect.any(String),
        sequence: expect.any(Number),
      }),
    );
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

describe("advanced playback controls", () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });
  it("applies and persists only supported playback speeds", async () => {
    const { audio } = setup();
    await act(async () => player.playStory(story));
    act(() => player.setSpeed(1.5));
    expect(audio.playbackRate).toBe(1.5);
    expect(localStorage.getItem("soundwave.playbackSpeed")).toBe("1.5");
    act(() => player.setSpeed(9));
    expect(audio.playbackRate).toBe(1.5);
    await act(async () => player.move(1));
    expect(audio.playbackRate).toBe(1.5);
  });
  it("restores the preferred speed on a fresh mount", () => {
    localStorage.setItem("soundwave.playbackSpeed", "1.25");
    const { audio } = setup();
    expect(audio.playbackRate).toBe(1.25);
  });
  it("pauses and saves when a sleep deadline expires; cancelling clears it", async () => {
    const { audio } = setup();
    await act(async () => player.playStory(story));
    vi.useFakeTimers();
    act(() => player.setSleepTimer(5));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300000);
    });
    expect(audio.paused).toBe(true);
    expect(player.sleepDeadline).toBe(null);
    expect(api.save).toHaveBeenCalled();
    act(() => player.setSleepTimer(15));
    expect(player.sleepRemaining).toBe(900);
    act(() => player.setSleepTimer(0));
    expect(player.sleepDeadline).toBe(null);
  });
  it("keyboard shortcuts control playback but do not hijack editable fields", async () => {
    const { audio, container } = setup();
    await act(async () => player.playStory(story));
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", code: "Space" }),
      ),
    );
    expect(audio.paused).toBe(true);
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })),
    );
    expect(audio.currentTime).toBe(10);
    const input = document.createElement("input");
    container.append(input);
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    expect(audio.currentTime).toBe(10);
  });
  it("handles shortcuts on focused playback buttons without hijacking other controls", async () => {
    const { audio, container } = setup();
    await act(async () => player.playStory(story));
    const button = document.createElement("button");
    button.setAttribute("data-player-shortcuts", "");
    container.append(button);
    button.focus();
    const press = async (target, key, extra = {}) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...extra,
      });
      await act(async () => target.dispatchEvent(event));
      return event;
    };
    expect((await press(button, " ")).defaultPrevented).toBe(true);
    expect(audio.paused).toBe(true);
    await press(button, "ArrowRight");
    expect(audio.currentTime).toBe(10);
    await press(button, "ArrowLeft");
    expect(audio.currentTime).toBe(0);
    await press(button, " ");
    expect(audio.paused).toBe(false);
    await press(button, " ", { repeat: true });
    expect(audio.paused).toBe(false);
    button.removeAttribute("data-player-shortcuts");
    expect((await press(button, " ")).defaultPrevented).toBe(false);
    expect(audio.paused).toBe(false);
    for (const tag of ["input", "textarea", "select"]) {
      const field = document.createElement(tag);
      container.append(field);
      expect((await press(field, "ArrowRight")).defaultPrevented).toBe(false);
      expect((await press(field, " ")).defaultPrevented).toBe(false);
    }
    expect(audio.currentTime).toBe(0);
  });
  it("cleans up sleep and keyboard listeners on unmount", async () => {
    const { unmount } = setup();
    await act(async () => player.playStory(story));
    vi.useFakeTimers();
    act(() => player.setSleepTimer(5));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  });
});

describe("playback analytics", () => {
  it("records native play/pause once and does not count seek distance as time", async () => {
    const { audio, rerender } = setup();
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    await act(async () => player.playStory(story));
    act(() => audio.dispatchEvent(new Event("playing")));
    expect(
      api.analyticsEvent.mock.calls.filter(
        ([e]) => e.type === "playback_started",
      ),
    ).toHaveLength(1);
    rerender(
      <PlayerProvider>
        <Probe />
      </PlayerProvider>,
    );
    expect(
      api.analyticsEvent.mock.calls.filter(
        ([e]) => e.type === "playback_started",
      ),
    ).toHaveLength(1);
    now.mockReturnValue(3000);
    await act(async () => {
      audio.currentTime = 28;
      player.toggle();
    });
    const paused = api.analyticsEvent.mock.calls.find(
      ([e]) => e.type === "playback_paused",
    )[0];
    expect(paused.listeningSeconds).toBe(2);
    expect(paused.chapterId).toBe(101);
    expect(paused.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("does not count buffering or the duration of a seek", async () => {
    const { audio } = setup();
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    await act(async () => player.playStory(story));
    now.mockReturnValue(2000);
    act(() => audio.dispatchEvent(new Event("waiting")));
    now.mockReturnValue(7000);
    act(() => audio.dispatchEvent(new Event("playing")));
    now.mockReturnValue(8000);
    act(() => audio.dispatchEvent(new Event("seeking")));
    now.mockReturnValue(12000);
    act(() => audio.dispatchEvent(new Event("seeked")));
    now.mockReturnValue(13000);
    await act(async () => player.toggle());
    const total = api.analyticsEvent.mock.calls.reduce(
      (sum, [event]) => sum + event.listeningSeconds,
      0,
    );
    expect(total).toBe(4);
  });
});

describe("independent audit regressions", () => {
  afterEach(() => vi.useRealTimers());
  it("coalesces a slider drag instead of flooding progress writes and the API rate limit", async () => {
    setup();
    await act(async () => player.playStory(story));
    api.save.mockClear();
    vi.useFakeTimers();
    await act(async () => {
      for (let i = 0; i < 80; i++) player.seek(i / 4);
    });
    expect(api.save).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save.mock.calls[0][1]).toBe(19.75);
  });
});

describe("out-of-order progress snapshots", () => {
  it("versions snapshots before dispatch so unload cannot be overwritten by an older in-flight save", async () => {
    const { audio } = setup();
    await act(async () => player.playStory(story));
    let finishOld;
    api.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    await act(async () => {
      audio.currentTime = 5;
      void player.retrySave();
      await Promise.resolve();
    });
    await act(async () => {
      audio.currentTime = 12;
      window.dispatchEvent(new Event("pagehide"));
    });
    const [old, newer] = api.save.mock.calls;
    expect(old[4]?.clientId).toBeTruthy();
    expect(newer[4]?.clientId).toBe(old[4].clientId);
    expect(newer[4]?.sequence).toBeGreaterThan(old[4].sequence);
    await act(async () => finishOld({}));
  });
});
