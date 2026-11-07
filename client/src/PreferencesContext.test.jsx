import React from "react";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { render, act, waitFor, cleanup } from "@testing-library/react";
import {
  PreferencesProvider,
  usePreferences,
  DEFAULT_PREFERENCES,
} from "./PreferencesContext";
import { api } from "./api";
vi.mock("./api", () => ({ api: { settings: vi.fn(), saveSettings: vi.fn() } }));
let preferences;
const session = { user: { id: "owner-a" }, csrfToken: "csrf-a" };
function Probe() {
  preferences = usePreferences();
  return <span>{preferences.settings.playbackSpeed}</span>;
}
function view(s = session) {
  return (
    <PreferencesProvider session={s}>
      <Probe />
    </PreferencesProvider>
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  api.settings.mockResolvedValue({ settings: { ...DEFAULT_PREFERENCES } });
  api.saveSettings.mockResolvedValue({
    settings: { ...DEFAULT_PREFERENCES, playbackSpeed: 1.5 },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("loads owner preferences and does not reload/remount on a display-name-only session update", async () => {
  api.settings.mockResolvedValue({
    settings: { ...DEFAULT_PREFERENCES, playbackSpeed: 1.25 },
  });
  const result = render(view());
  await waitFor(() => expect(preferences.ready).toBe(true));
  expect(preferences.settings.playbackSpeed).toBe(1.25);
  result.rerender(
    view({ ...session, user: { id: "owner-a", displayName: "Renamed" } }),
  );
  expect(api.settings).toHaveBeenCalledTimes(1);
  expect(api.settings).toHaveBeenCalledWith(
    expect.any(AbortSignal),
    expect.objectContaining({ user: { id: "owner-a" }, csrfToken: "csrf-a" }),
  );
});
it("serializes rapid writes and ignores a late stale initial read", async () => {
  let read, first;
  api.settings.mockImplementation(
    () =>
      new Promise((r) => {
        read = r;
      }),
  );
  api.saveSettings
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          first = r;
        }),
    )
    .mockResolvedValueOnce({
      settings: {
        ...DEFAULT_PREFERENCES,
        playbackSpeed: 1.5,
        autoplayNext: false,
      },
    });
  render(view());
  let p1, p2;
  await act(async () => {
    p1 = preferences.update({ playbackSpeed: 1.5 });
    p2 = preferences.update({ autoplayNext: false });
    await Promise.resolve();
  });
  expect(api.saveSettings).toHaveBeenCalledTimes(1);
  await act(async () => {
    first({ settings: { ...DEFAULT_PREFERENCES, playbackSpeed: 1.5 } });
    await p1;
    await p2;
  });
  await act(() => read({ settings: { ...DEFAULT_PREFERENCES } }));
  expect(preferences.settings.playbackSpeed).toBe(1.5);
  expect(preferences.settings.autoplayNext).toBe(false);
  expect(preferences.pending).toBe(0);
  expect(api.saveSettings).toHaveBeenLastCalledWith(
    { autoplayNext: false },
    expect.objectContaining({ user: { id: "owner-a" } }),
  );
});
it("recovers from read/save errors without silently claiming persistence", async () => {
  api.settings.mockRejectedValueOnce(Error("Unavailable"));
  render(view());
  await waitFor(() => expect(preferences.error).toContain("Unavailable"));
  expect(preferences.ready).toBe(false);
  await act(() => preferences.reload());
  expect(preferences.ready).toBe(true);
  api.saveSettings.mockRejectedValueOnce(Error("Write failed"));
  await act(async () => {
    await expect(preferences.update({ playbackSpeed: 2 })).rejects.toThrow(
      "Write failed",
    );
  });
  expect(preferences.error).toContain("Write failed");
  expect(preferences.settings.playbackSpeed).toBe(1);
  await act(() => preferences.reload());
  expect(preferences.error).toBe("");
});
it("aborts old reads and discards old write responses on account switching", async () => {
  let finish;
  api.saveSettings.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const rendered = render(view());
  await waitFor(() => expect(preferences.ready).toBe(true));
  const oldRead = api.settings.mock.calls[0][0];
  let pending;
  await act(async () => {
    pending = preferences.update({ playbackSpeed: 2 });
    await Promise.resolve();
  });
  rendered.rerender(view({ user: { id: "owner-b" }, csrfToken: "csrf-b" }));
  await waitFor(() => expect(preferences.ready).toBe(true));
  await act(async () => {
    finish({ settings: { ...DEFAULT_PREFERENCES, playbackSpeed: 2 } });
    await pending;
  });
  expect(oldRead.aborted).toBe(true);
  expect(preferences.settings.playbackSpeed).toBe(1);
  expect(api.settings).toHaveBeenLastCalledWith(
    expect.any(AbortSignal),
    expect.objectContaining({ user: { id: "owner-b" } }),
  );
});
it("does not read/store private preferences for an offline anonymous visitor", async () => {
  render(view({ user: null, offline: true }));
  expect(api.settings).not.toHaveBeenCalled();
  expect(preferences.settings).toEqual(DEFAULT_PREFERENCES);
  await act(async () => {
    await expect(preferences.update({ playbackSpeed: 2 })).rejects.toThrow(
      "online account",
    );
  });
  expect(api.saveSettings).not.toHaveBeenCalled();
});
