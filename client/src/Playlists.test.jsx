import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Playlists from "./Playlists";
import { api } from "./api";
let auth;
vi.mock("./AuthContext", () => ({ useAuth: () => auth }));
vi.mock("./components", () => ({
  SectionHeading: ({ title }) => <h2>{title}</h2>,
  StoryCard: ({ story }) => <div>{story.title}</div>,
  Loading: ({ label }) => <p role="status">{label}</p>,
  ErrorState: ({ message, retry }) => (
    <div role="alert">
      {message}
      <button onClick={retry}>Retry read</button>
    </div>
  ),
}));
vi.mock("./api", () => ({
  api: Object.fromEntries(
    [
      "playlists",
      "playlist",
      "createPlaylist",
      "renamePlaylist",
      "deletePlaylist",
      "addPlaylistStory",
      "removePlaylistStory",
      "stories",
    ].map((k) => [k, vi.fn()]),
  ),
}));
const id = "aa000000-0000-0000-0000-000000000001";
const p = { id, name: "Evening stories", storyCount: 0 };
function view(path = "/library") {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Playlists />
    </MemoryRouter>
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  auth = { user: { id: "listener-1" }, csrfToken: "session-1" };
  api.playlists.mockResolvedValue({ playlists: [], nextCursor: null });
  api.playlist.mockResolvedValue({ playlist: { ...p }, stories: [] });
  api.stories.mockResolvedValue({
    stories: [{ id: 1, title: "The Midnight Frequency" }],
  });
});
afterEach(cleanup);

it("creates and opens a private playlist, clearing the form only after success", async () => {
  api.createPlaylist.mockResolvedValue({ playlist: p });
  render(view());
  await screen.findByText("No playlists yet");
  fireEvent.change(screen.getByLabelText("Playlist name"), {
    target: { value: p.name },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create playlist" }));
  await screen.findByText("Playlist created.");
  await screen.findByRole("heading", { name: p.name });
  expect(api.createPlaylist).toHaveBeenCalledWith(
    p.name,
    expect.objectContaining({ user: auth.user, csrfToken: auth.csrfToken }),
  );
  expect(screen.getByLabelText("Playlist name").value).toBe("");
});

it("shows a recoverable mutation error and prevents duplicate pending submissions", async () => {
  let reject;
  api.createPlaylist.mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  render(view());
  await screen.findByText("No playlists yet");
  fireEvent.change(screen.getByLabelText("Playlist name"), {
    target: { value: "Keep this input" },
  });
  const button = screen.getByRole("button", { name: "Create playlist" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.createPlaylist).toHaveBeenCalledTimes(1);
  await act(() => reject(Error("Network unavailable")));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain(
    "Network unavailable",
  );
  expect(screen.getByLabelText("Playlist name").value).toBe("Keep this input");
  api.createPlaylist.mockResolvedValue({ playlist: p });
  fireEvent.click(button);
  await screen.findByText("Playlist created.");
});

it("loads a second page and preserves the first page on a recoverable page error", async () => {
  api.playlists
    .mockResolvedValueOnce({ playlists: [p], nextCursor: "page-two" })
    .mockRejectedValueOnce(Error("Read failed"))
    .mockResolvedValue({ playlists: [p], nextCursor: null });
  render(view());
  await screen.findByRole("button", { name: "Open playlist Evening stories" });
  fireEvent.click(screen.getByRole("button", { name: "Load more playlists" }));
  await screen.findByText("Read failed");
  expect(
    screen.getByRole("button", { name: "Open playlist Evening stories" }),
  ).toBeTruthy();
  expect(api.playlists).toHaveBeenNthCalledWith(
    2,
    { cursor: "page-two" },
    expect.any(AbortSignal),
    expect.objectContaining({ user: auth.user }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry read" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("requires confirmation for deletion and exposes server membership errors without discarding the story choice", async () => {
  api.addPlaylistStory.mockRejectedValue(Error("Playlist is full"));
  api.deletePlaylist.mockResolvedValue(null);
  render(view(`/library?playlist=${id}`));
  await screen.findByRole("heading", { name: p.name });
  fireEvent.change(screen.getByLabelText("Story to add"), {
    target: { value: "1" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Add story to playlist" }),
  );
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Story to add").value).toBe("1");
  fireEvent.click(
    screen.getByRole("button", { name: "Delete playlist", exact: true }),
  );
  expect(api.deletePlaylist).not.toHaveBeenCalled();
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel deletion" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Delete playlist", exact: true }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm delete playlist" }),
  );
  await screen.findByText("Playlist deleted.");
  expect(api.deletePlaylist).toHaveBeenCalledWith(
    id,
    expect.objectContaining({ csrfToken: "session-1" }),
  );
});

it("aborts pending private reads and discards old data when the session changes", async () => {
  let finish;
  api.playlists.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const rendered = render(view());
  await waitFor(() => expect(api.playlists).toHaveBeenCalledTimes(1));
  const oldSignal = api.playlists.mock.calls[0][1];
  auth = { user: { id: "listener-2" }, csrfToken: "session-2" };
  rendered.rerender(view());
  await screen.findByText("No playlists yet");
  await act(() => finish({ playlists: [p], nextCursor: null }));
  expect(oldSignal.aborted).toBe(true);
  expect(
    screen.queryByRole("button", { name: "Open playlist Evening stories" }),
  ).toBeNull();
  expect(api.playlists).toHaveBeenLastCalledWith(
    {},
    expect.any(AbortSignal),
    expect.objectContaining({ user: { id: "listener-2" } }),
  );
});

it("makes no private playlist request while signed out/offline", () => {
  auth = { user: null, offline: true };
  render(view());
  expect(screen.getByText(/Sign in or start a demo session/)).toBeTruthy();
  expect(api.playlists).not.toHaveBeenCalled();
});
