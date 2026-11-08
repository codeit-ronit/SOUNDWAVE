import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { PlayerProvider, usePlayer } from "./PlayerContext";
import { api } from "./api";
import {
  PreferencesProvider,
  usePreferences,
  DEFAULT_PREFERENCES,
} from "./PreferencesContext";
vi.mock("./api", () => ({
  api: {
    progress: vi.fn(),
    chapters: vi.fn(),
    save: vi.fn(),
    analyticsEvent: vi.fn(),
    settings: vi.fn(),
    saveSettings: vi.fn(),
    progressChapter: vi.fn(),
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
let player, preferences, storedPreferences;
const progressAck = (id, position, completed, _keepalive, version) => ({
  progress: {
    chapter_id: id,
    position_seconds: position,
    completed,
    revision: version.expectedRevision + 1,
  },
  acknowledgedRevision: version.expectedRevision + 1,
  replayed: false,
});
function Probe() {
  player = usePlayer();
  preferences = usePreferences();
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
  sessionStorage.clear();
  vi.clearAllMocks();
  api.progress.mockResolvedValue({ progress: [], continueListening: [] });
  api.chapters.mockResolvedValue({ chapters });
  api.save.mockImplementation(async (...args) => progressAck(...args));
  api.progressChapter.mockResolvedValue({
    progress: {
      chapter_id: 101,
      position_seconds: 0,
      completed: false,
      revision: 0,
    },
  });
  api.analyticsEvent.mockResolvedValue({});
  storedPreferences = { ...DEFAULT_PREFERENCES };
  api.settings.mockImplementation(async () => ({
    settings: storedPreferences,
  }));
  api.saveSettings.mockImplementation(async (patch) => {
    storedPreferences = { ...storedPreferences, ...patch };
    return { settings: storedPreferences };
  });
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
function accountSetup() {
  const result = render(
    <PreferencesProvider
      session={{ user: { id: "account-player" }, csrfToken: "account-csrf" }}
    >
      <PlayerProvider>
        <Probe />
      </PlayerProvider>
    </PreferencesProvider>,
  );
  return { ...result, audio: result.container.querySelector("audio") };
}
it("applies account preferences without replacing audio, losing position or resetting a temporary volume override", async () => {
  storedPreferences = {
    ...DEFAULT_PREFERENCES,
    playbackSpeed: 1.25,
    defaultVolume: 0.4,
  };
  const { audio, container } = accountSetup();
  await waitFor(() => expect(preferences.ready).toBe(true));
  await act(() => player.playStory(story));
  audio.currentTime = 9;
  expect(audio.playbackRate).toBe(1.25);
  expect(audio.volume).toBe(0.4);
  await act(() =>
    preferences.update({ playbackSpeed: 1.5, defaultVolume: 0.6 }),
  );
  expect(container.querySelector("audio")).toBe(audio);
  expect(audio.currentTime).toBe(9);
  expect(audio.paused).toBe(false);
  expect(audio.volume).toBe(0.6);
  expect(audio.playbackRate).toBe(1.5);
  act(() => player.setVolume(0.2));
  await act(() => preferences.update({ autoplayNext: false }));
  expect(audio.volume).toBe(0.2);
  expect(audio.currentTime).toBe(9);
});
it("disables automatic next-chapter playback while keeping manual next available", async () => {
  storedPreferences = { ...DEFAULT_PREFERENCES, autoplayNext: false };
  const { audio } = accountSetup();
  await waitFor(() => expect(preferences.ready).toBe(true));
  await act(() => player.playStory(story));
  await act(async () => {
    audio.currentTime = 30;
    audio.dispatchEvent(new Event("ended"));
    await Promise.resolve();
  });
  expect(player.active.chapter.id).toBe(101);
  expect(player.playing).toBe(false);
  expect(player.hasNext).toBe(true);
  expect(
    api.save.mock.calls.some((call) => call[0] === 101 && call[2] === true),
  ).toBe(true);
  await act(() => player.move(1));
  expect(player.active.chapter.id).toBe(102);
  expect(player.playing).toBe(true);
});
it("uses safe account defaults instead of another listener's old device speed and persists player speed changes", async () => {
  localStorage.setItem("soundwave.playbackSpeed", "2");
  const { audio } = accountSetup();
  await waitFor(() => expect(preferences.ready).toBe(true));
  expect(player.speed).toBe(1);
  await act(async () => {
    player.setSpeed(1.5);
    await Promise.resolve();
  });
  await waitFor(() => expect(preferences.settings.playbackSpeed).toBe(1.5));
  expect(audio.playbackRate).toBe(1.5);
  expect(api.saveSettings).toHaveBeenCalledWith(
    { playbackSpeed: 1.5 },
    expect.objectContaining({ user: { id: "account-player" } }),
  );
});
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
    expect(api.save).toHaveBeenCalledTimes(1);
    const old = api.save.mock.calls[0];
    await act(async () => finishOld(progressAck(...old)));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
    const newer = api.save.mock.calls[1];
    expect(old[4]?.clientId).toBeTruthy();
    expect(newer[4].clientId).toBe(old[4].clientId);
    expect(newer[4].sequence).toBeGreaterThan(old[4].sequence);
    expect(newer[4].expectedRevision).toBe(old[4].expectedRevision + 1);
  });
});

it("a queued media frame safely stops after an account unmount detaches audio", async () => {
  let frame;
  const raf = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((fn) => {
      frame = fn;
      return 1;
    });
  const cancel = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation(() => {});
  try {
    const view = setup();
    await act(() => player.playStory(story));
    expect(frame).toBeTypeOf("function");
    view.unmount();
    const count = raf.mock.calls.length;
    expect(() => frame()).not.toThrow();
    expect(raf).toHaveBeenCalledTimes(count);
  } finally {
    raf.mockRestore();
    cancel.mockRestore();
  }
});

describe("cross-story editable queue", () => {
  const other = { id: 2, title: "Another story" };
  const otherChapters = [
    {
      ...chapters[0],
      id: 201,
      title: "Other one",
      audio_url: "/audio/2-1.wav",
    },
    {
      ...chapters[1],
      id: 202,
      title: "Other two",
      audio_url: "/audio/2-2.wav",
    },
  ];
  beforeEach(() =>
    api.chapters.mockImplementation(async (id) => ({
      chapters: id === 2 ? otherChapters : chapters,
    })),
  );
  it("Play Next preempts the story tail; duplicates replay as distinct occurrences", async () => {
    const { audio } = setup();
    await act(() => player.playStory(story));
    const currentId = player.queue.current.id;
    await act(() => player.enqueue(other, 201, true));
    await act(() => player.enqueue(other, 201));
    expect(player.queue.upcoming.map((e) => e.chapter.id)).toEqual([
      201, 102, 201,
    ]);
    expect(new Set(player.queue.upcoming.map((e) => e.id)).size).toBe(3);
    act(() => player.move(1));
    expect(player.active.story.id).toBe(2);
    expect(audio.currentTime).toBe(0);
    act(() => player.move(1));
    act(() => player.move(1));
    expect(player.active.chapter.id).toBe(201);
    expect(player.active.entryId).not.toBe(currentId);
  });
  it("rapid Next operations consume different entries without async stale selections", async () => {
    setup();
    await act(() => player.playStory(story));
    await act(() => player.enqueue(other));
    act(() => {
      player.move(1);
      player.move(1);
      player.move(1);
    });
    expect(player.active.chapter.id).toBe(202);
    expect(player.queue.upcoming).toHaveLength(0);
    expect(player.hasNext).toBe(false);
    act(() => player.move(-1));
    expect(player.active.chapter.id).toBe(201);
    expect(player.queue.upcoming[0].chapter.id).toBe(202);
  });
  it("queue edits preserve active audio, time, rate and volume", async () => {
    const { audio } = setup();
    await act(() => player.playStory(story));
    await act(() => player.enqueue(other));
    audio.currentTime = 8;
    act(() => {
      player.setSpeed(1.5);
      player.setVolume(0.3);
    });
    const id = player.queue.upcoming[2].id;
    act(() => player.editQueue({ type: "move", id, delta: -1 }));
    act(() => player.editQueue({ type: "remove", id }));
    expect(player.active.chapter.id).toBe(101);
    expect(audio.currentTime).toBe(8);
    expect(audio.paused).toBe(false);
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.volume).toBe(0.3);
    act(() => player.editQueue({ type: "clear" }));
    expect(player.hasNext).toBe(false);
    expect(audio.paused).toBe(false);
  });
  it("duplicate ended events and a delayed completion cannot skip a manually selected next entry", async () => {
    const { audio } = setup();
    await act(() => player.playStory(story));
    await act(() => player.enqueue(other));
    let finish;
    api.save.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    await act(async () => {
      audio.dispatchEvent(new Event("ended"));
      audio.dispatchEvent(new Event("ended"));
      await Promise.resolve();
    });
    act(() => player.move(1));
    expect(player.active.chapter.id).toBe(102);
    await act(async () => {
      finish(progressAck(...api.save.mock.calls[0]));
      await Promise.resolve();
    });
    expect(player.active.chapter.id).toBe(102);
    expect(api.save.mock.calls.filter((c) => c[2] === true)).toHaveLength(1);
  });
  it("completion takes the latest reordered upcoming item across stories", async () => {
    const { audio } = setup();
    await act(() => player.playStory(story));
    await act(() => player.enqueue(other, 201));
    act(() =>
      player.editQueue({
        type: "move",
        id: player.queue.upcoming[1].id,
        delta: -1,
      }),
    );
    await act(async () => {
      audio.dispatchEvent(new Event("ended"));
      await Promise.resolve();
    });
    expect(player.active.chapter.id).toBe(201);
    expect(player.queue.upcoming[0].chapter.id).toBe(102);
  });
  it("an empty queue stops at completion and manual Next is a no-op", async () => {
    const { audio } = setup();
    await act(() => player.playStory(story));
    act(() => player.editQueue({ type: "clear" }));
    await act(async () => {
      audio.dispatchEvent(new Event("ended"));
      await Promise.resolve();
    });
    expect(player.playing).toBe(false);
    expect(player.active.chapter.id).toBe(101);
    act(() => player.move(1));
    expect(player.active.chapter.id).toBe(101);
  });
  it("clearing cancels pending enqueue work instead of repopulating the queue", async () => {
    setup();
    await act(() => player.playStory(story));
    let finish;
    api.chapters.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    let adding;
    await act(async () => {
      adding = player.enqueue(other);
      await Promise.resolve();
    });
    act(() => player.editQueue({ type: "clear" }));
    await act(async () => {
      finish({ chapters: otherChapters });
      await adding;
    });
    expect(player.queue.upcoming).toEqual([]);
  });
  it("direct selection wins over an older in-flight story load", async () => {
    setup();
    await act(() => player.playStory(story));
    let finish;
    api.chapters.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    let pending;
    await act(async () => {
      pending = player.playStory(other);
      await Promise.resolve();
    });
    await act(() => player.playStory(story, 102));
    await act(async () => {
      finish({ chapters: otherChapters });
      await pending;
    });
    expect(player.active.chapter.id).toBe(102);
  });
});

it("bounds a stalled restoration without blocking replacement playback", async () => {
  vi.useFakeTimers();
  api.progress.mockImplementationOnce(() => new Promise(() => {}));
  const view = setup();
  try {
    expect(player.queueReady).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(15000);
    });
    expect(player.queueReady).toBe(true);
    expect(player.queueError).toContain("timed out");
    expect(api.progress.mock.calls[0][0].aborted).toBe(true);
    await act(() => player.playStory(story));
    expect(player.active.chapter.id).toBe(101);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it("rejects an undownloaded offline enqueue without modifying the queue", async () => {
  const view = setup();
  await act(() => player.playStory(story));
  const before = player.queue.upcoming;
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  vi.stubGlobal("caches", {
    open: vi
      .fn()
      .mockResolvedValue({ match: vi.fn().mockResolvedValue(undefined) }),
  });
  try {
    await act(() => player.enqueue(story, 101));
    expect(player.queueError).toContain("Only downloaded");
    expect(player.queue.upcoming).toBe(before);
  } finally {
    online.mockRestore();
    vi.unstubAllGlobals();
    view.unmount();
  }
});

describe("cross-device player synchronization", () => {
  const remote = (revision = 1, pos = 12, completed = false) => ({
    chapter_id: 101,
    revision,
    position_seconds: pos,
    completed,
  });
  it("foreground reads preserve active playback and Resume Latest adopts paused without consuming the queue", async () => {
    const { audio } = setup();
    await act(() => player.playStory(story));
    audio.currentTime = 5;
    const ids = player.queue.upcoming.map((e) => e.id);
    const loads = HTMLMediaElement.prototype.load.mock.calls.length;
    api.progressChapter.mockResolvedValueOnce({ progress: remote() });
    await act(() => player.refreshProgress(true));
    expect(audio.currentTime).toBe(5);
    expect(audio.paused).toBe(false);
    expect(player.progressConflict.server.revision).toBe(1);
    await act(() => player.resolveProgress("latest"));
    expect(audio.currentTime).toBe(12);
    expect(audio.paused).toBe(true);
    expect(player.queue.upcoming.map((e) => e.id)).toEqual(ids);
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(loads);
    expect(api.save).not.toHaveBeenCalled();
  });
  it("Keep My Position is a conditional write and leaves audio playing", async () => {
    const { audio } = setup();
    await act(() => player.playStory(story));
    audio.currentTime = 5;
    api.progressChapter.mockResolvedValueOnce({ progress: remote() });
    await act(() => player.refreshProgress(true));
    await act(() => player.resolveProgress("keep"));
    expect(api.save.mock.calls[0][1]).toBe(5);
    expect(api.save.mock.calls[0][4].expectedRevision).toBe(1);
    expect(audio.currentTime).toBe(5);
    expect(audio.paused).toBe(false);
    expect(player.progressConflict).toBeNull();
  });
  it("clean paused progress adopts a newer foreground revision without autoplay or an extra write", async () => {
    const { audio } = setup();
    await act(() => player.playStory(story));
    audio.currentTime = 5;
    await act(() => player.toggle());
    const count = api.save.mock.calls.length;
    api.progressChapter.mockResolvedValueOnce({ progress: remote(2, 15) });
    await act(() => player.refreshProgress(true));
    expect(audio.currentTime).toBe(15);
    expect(audio.paused).toBe(true);
    expect(api.save).toHaveBeenCalledTimes(count);
    expect(player.progressConflict).toBeNull();
  });
  it("an old chapter's delayed conflict cannot replace the newly selected chapter UI", async () => {
    const { audio } = setup();
    await act(() => player.playStory(story));
    let reject;
    api.save.mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    await act(async () => {
      audio.currentTime = 5;
      void player.retrySave();
      await Promise.resolve();
    });
    act(() => player.move(1));
    await act(async () => {
      reject(
        Object.assign(Error("Conflict"), {
          status: 409,
          code: "PROGRESS_CONFLICT",
          progress: remote(),
        }),
      );
      await Promise.resolve();
    });
    expect(player.active.chapter.id).toBe(102);
    expect(player.progressConflict).toBeNull();
  });
  it("a conflict on completion cannot silently advance into the next occurrence", async () => {
    const { audio } = setup();
    await act(() => player.playStory(story));
    api.save.mockRejectedValueOnce(
      Object.assign(Error("Conflict"), { status: 409, progress: remote() }),
    );
    await act(async () => {
      audio.currentTime = 30;
      audio.dispatchEvent(new Event("ended"));
      await Promise.resolve();
    });
    expect(player.active.chapter.id).toBe(101);
    expect(player.progressConflict).toBeTruthy();
    expect(player.hasNext).toBe(true);
  });
  it("offline progress stays unsynchronized and reconnection surfaces a newer accepted revision", async () => {
    const { audio } = setup();
    await act(() => player.playStory(story));
    audio.currentTime = 8;
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      await act(() => player.toggle());
      expect(player.saveError).toContain("not synchronized");
      expect(api.save).not.toHaveBeenCalled();
      online.mockReturnValue(true);
      api.progressChapter.mockResolvedValueOnce({ progress: remote(1, 15) });
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await Promise.resolve();
      });
      await waitFor(() => expect(player.progressConflict).toBeTruthy());
      expect(audio.currentTime).toBe(8);
      expect(audio.paused).toBe(true);
      expect(api.save).not.toHaveBeenCalled();
    } finally {
      online.mockRestore();
    }
  });
  it("account unmount aborts an outstanding read and discards its delayed result", async () => {
    const view = setup();
    await act(() => player.playStory(story));
    let finish;
    api.progressChapter.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    let pending;
    await act(async () => {
      pending = player.refreshProgress(true);
      await Promise.resolve();
    });
    const signal = api.progressChapter.mock.calls.at(-1)[1];
    view.unmount();
    setup();
    await act(async () => {
      finish({ progress: remote() });
      await pending;
    });
    expect(signal.aborted).toBe(true);
    expect(player.active).toBeNull();
    expect(player.progressConflict).toBeNull();
  });
});

it("bounds stalled foreground requests and leaves active audio untouched", async () => {
  vi.useFakeTimers();
  const view = setup();
  try {
    await act(() => player.playStory(story));
    view.audio.currentTime = 5;
    api.progressChapter.mockImplementationOnce(() => new Promise(() => {}));
    let pending;
    await act(async () => {
      pending = player.refreshProgress(true);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
      await pending;
    });
    expect(player.syncing).toBe(false);
    expect(player.saveError).toContain("timed out");
    expect(view.audio.currentTime).toBe(5);
    expect(view.audio.paused).toBe(false);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
it("coalesces foreground/connectivity bursts without continuously polling playback", async () => {
  vi.useFakeTimers();
  const view = setup(),
    visible = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
  try {
    await act(() => player.playStory(story));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.progressChapter).toHaveBeenCalledTimes(1);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(1400);
    });
    expect(api.progressChapter).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(101));
    expect(api.progressChapter).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(api.progressChapter).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    visible.mockRestore();
    vi.useRealTimers();
  }
});
it("a late write retains its original session and cannot update the next account", async () => {
  const ownerA = {
      user: { id: "10000000-0000-4000-8000-000000000001" },
      csrfToken: "csrf-a",
    },
    ownerB = {
      user: { id: "20000000-0000-4000-8000-000000000002" },
      csrfToken: "csrf-b",
    };
  const view = render(
    <PlayerProvider key="a" session={ownerA}>
      <Probe />
    </PlayerProvider>,
  );
  await act(() => player.playStory(story));
  let finish;
  api.save.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  let pending;
  await act(async () => {
    pending = player.retrySave();
    await Promise.resolve();
  });
  const original = api.save.mock.calls[0];
  view.rerender(
    <PlayerProvider key="b" session={ownerB}>
      <Probe />
    </PlayerProvider>,
  );
  await act(async () => {
    finish(progressAck(...original));
    await pending;
  });
  expect(original[5]).toEqual(ownerA);
  expect(player.active).toBeNull();
  expect(player.progressConflict).toBeNull();
});
it("a small pending rewind is not overwritten by a foreground read", async () => {
  const view = setup();
  await act(() => player.playStory(story));
  view.audio.currentTime = 5;
  await act(() => player.toggle());
  act(() => player.seek(4.9));
  api.progressChapter.mockResolvedValueOnce({
    progress: {
      chapter_id: 101,
      revision: 2,
      position_seconds: 12,
      completed: false,
    },
  });
  await act(() => player.refreshProgress(true));
  expect(view.audio.currentTime).toBe(4.9);
  expect(player.progressConflict.server.revision).toBe(2);
});
