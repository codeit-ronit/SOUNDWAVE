import React from "react";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import QueuePanel, { QueueActions } from "./QueuePanel";
let player;
vi.mock("./PlayerContext", () => ({ usePlayer: () => player }));
beforeEach(() => {
  player = {
    queue: { current: null, history: [], upcoming: [] },
    queueReady: true,
    enqueue: vi.fn().mockResolvedValue(),
    editQueue: vi.fn(),
    move: vi.fn(),
    dismissQueueError: vi.fn(),
  };
});
afterEach(cleanup);
const show = (child) => render(<MemoryRouter>{child}</MemoryRouter>);
it("shows empty/restoring states and a recoverable warning", () => {
  player.queueReady = false;
  const v = show(<QueuePanel />);
  expect(screen.getByText("Restoring your queue…")).toBeTruthy();
  player.queueReady = true;
  player.queueError = "Storage full";
  v.rerender(
    <MemoryRouter>
      <QueuePanel />
    </MemoryRouter>,
  );
  expect(screen.getByText(/Nothing up next/)).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Storage full");
  fireEvent.click(screen.getByText("Dismiss queue warning"));
  expect(player.dismissQueueError).toHaveBeenCalledOnce();
});
it("exposes ordered accessible controls and requires confirmation to clear", () => {
  const entry = (id, title) => ({
    id,
    story: { title: "Story" },
    chapter: { title },
  });
  player.queue.current = entry("current", "Current");
  player.queue.upcoming = [entry("a", "First"), entry("b", "Second")];
  player.hasNext = true;
  show(<QueuePanel />);
  expect(
    screen.getByRole("button", { name: "Move queue item 1 up" }).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Move queue item 2 up" }));
  expect(player.editQueue).toHaveBeenCalledWith({
    type: "move",
    id: "b",
    delta: -1,
  });
  fireEvent.click(screen.getByText("Clear upcoming queue"));
  expect(player.editQueue).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("Keep queue"));
  expect(screen.queryByText("Confirm clear upcoming")).toBeNull();
  fireEvent.click(screen.getByText("Clear upcoming queue"));
  fireEvent.click(screen.getByText("Confirm clear upcoming"));
  expect(player.editQueue).toHaveBeenLastCalledWith({ type: "clear" });
});
it("enqueues one chapter or an entire playlist story without changing playlist data", async () => {
  const story = { id: 2, title: "Another story" };
  show(<QueueActions story={story} chapter={{ id: 201, title: "Chapter" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Play next: Chapter" }));
  expect(player.enqueue).toHaveBeenCalledWith(story, 201, true);
});
