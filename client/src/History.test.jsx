import React from "react";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  cleanup,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import History from "./History";
import { api } from "./api";
let auth, player, rows;
vi.mock("./AuthContext", () => ({ useAuth: () => auth }));
vi.mock("./PlayerContext", () => ({ usePlayer: () => player }));
vi.mock("./api", () => ({
  api: { history: vi.fn(), removeHistory: vi.fn(), clearHistory: vi.fn() },
}));
const entry = (id) => ({
  chapter_id: id,
  chapter_title: `Chapter ${id}`,
  story_id: 1,
  story_title: "Story",
  position_seconds: 5,
  duration_seconds: 35,
  revision: 1,
  completed: false,
  story: { id: 1, title: "Story", color: "purple", symbol: "radio" },
});
const show = () =>
  render(
    <MemoryRouter>
      <History />
    </MemoryRouter>,
  );
beforeEach(() => {
  vi.resetAllMocks();
  auth = { user: { id: "owner-a" }, csrfToken: "csrf-a" };
  player = { playStory: vi.fn(), historyRemoved: vi.fn().mockResolvedValue() };
  rows = [entry(101)];
  api.history.mockImplementation(async () => ({
    entries: rows,
    historyRevision: 1,
    nextCursor: null,
  }));
  api.removeHistory.mockImplementation(async () => {
    rows = [];
    return {
      removed: true,
      progress: { chapter_id: 101, revision: 2, removed: true },
    };
  });
  api.clearHistory.mockImplementation(async () => {
    rows = [];
    return { cleared: true, removedCount: 1, historyRevision: 2 };
  });
});
afterEach(cleanup);
it("loads saved chapters, explains retained analytics, and resumes through the existing player", async () => {
  show();
  await screen.findByText("Chapter 101");
  expect(screen.getByText(/not full data erasure/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Resume Chapter 101" }));
  expect(player.playStory).toHaveBeenCalledWith(rows[0].story, 101);
});
it("requires confirmation and refreshes history after individual removal", async () => {
  show();
  await screen.findByText("Chapter 101");
  fireEvent.click(
    screen.getByRole("button", { name: "Remove Chapter 101 from history" }),
  );
  expect(api.removeHistory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Cancel removal"));
  expect(api.removeHistory).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove Chapter 101 from history" }),
  );
  fireEvent.click(screen.getByText("Confirm remove chapter"));
  await screen.findByText("No saved history");
  expect(api.removeHistory).toHaveBeenCalledWith(
    101,
    1,
    expect.any(AbortSignal),
    expect.objectContaining({ user: { id: "owner-a" } }),
  );
  expect(player.historyRemoved).toHaveBeenCalled();
});
it("bulk clear sends the displayed guard and handles a concurrent-history conflict recoverably", async () => {
  api.clearHistory.mockRejectedValueOnce(
    Object.assign(Error("History changed"), { status: 409 }),
  );
  show();
  await screen.findByText("Chapter 101");
  fireEvent.click(screen.getByText("Clear saved history"));
  fireEvent.click(screen.getByText("Confirm clear history"));
  await screen.findByRole("alert");
  expect(api.clearHistory.mock.calls[0][0]).toBe(1);
  expect(screen.getByText("Clear saved history").disabled).toBe(true);
  fireEvent.click(screen.getByText("Try again"));
  await waitFor(() =>
    expect(screen.getByText("Clear saved history").disabled).toBe(false),
  );
  fireEvent.click(screen.getByText("Clear saved history"));
  fireEvent.click(screen.getByText("Confirm clear history"));
  await screen.findByText("No saved history");
  expect(player.historyRemoved).toHaveBeenCalledWith(undefined);
});
it("loads bounded pages and refuses to adopt a newer clear guard from an appended page", async () => {
  api.history
    .mockResolvedValueOnce({
      entries: [entry(101)],
      nextCursor: "next",
      historyRevision: 1,
    })
    .mockResolvedValueOnce({
      entries: [entry(102)],
      nextCursor: null,
      historyRevision: 2,
    });
  show();
  await screen.findByText("Chapter 101");
  fireEvent.click(screen.getByText("Load more history"));
  await screen.findByText("Chapter 102");
  expect(api.history.mock.calls[1][0].get("cursor")).toBe("next");
  expect(screen.getByText("Clear saved history").disabled).toBe(true);
});
it("old reads and mutations cannot populate the next account", async () => {
  let finish;
  api.removeHistory.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const view = show();
  await screen.findByText("Chapter 101");
  fireEvent.click(
    screen.getByRole("button", { name: "Remove Chapter 101 from history" }),
  );
  fireEvent.click(screen.getByText("Confirm remove chapter"));
  await waitFor(() => expect(api.removeHistory).toHaveBeenCalledOnce());
  auth = { user: { id: "owner-b" }, csrfToken: "csrf-b" };
  rows = [];
  view.rerender(
    <MemoryRouter>
      <History />
    </MemoryRouter>,
  );
  await screen.findByText("No saved history");
  await act(() =>
    finish({ removed: true, progress: { chapter_id: 101, removed: true } }),
  );
  expect(player.historyRemoved).not.toHaveBeenCalled();
  expect(screen.queryByText(/entry removed/)).toBeNull();
  expect(api.removeHistory.mock.calls[0][2].aborted).toBe(true);
});
it("read failures retry and signed-out users have no private history controls", async () => {
  api.history.mockRejectedValueOnce(Error("Unavailable"));
  const view = show();
  await screen.findByText("Unavailable");
  fireEvent.click(screen.getByText("Try again"));
  await screen.findByText("Chapter 101");
  auth = { user: null };
  view.rerender(
    <MemoryRouter>
      <History />
    </MemoryRouter>,
  );
  expect(screen.queryByText("Chapter 101")).toBeNull();
  expect(screen.getByText(/History is unavailable offline/)).toBeTruthy();
});
it("discards a delayed history read after switching authenticated accounts", async () => {
  let finish;
  api.history.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = show();
  await waitFor(() => expect(api.history).toHaveBeenCalledOnce());
  const oldSignal = api.history.mock.calls[0][1];
  auth = { user: { id: "owner-b" }, csrfToken: "csrf-b" };
  rows = [];
  view.rerender(
    <MemoryRouter>
      <History />
    </MemoryRouter>,
  );
  await screen.findByText("No saved history");
  await act(() =>
    finish({ entries: [entry(101)], historyRevision: 1, nextCursor: null }),
  );
  expect(oldSignal.aborted).toBe(true);
  expect(screen.queryByText("Chapter 101")).toBeNull();
});
