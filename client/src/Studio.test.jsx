import React from "react";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  cleanup,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Studio from "./Studio";
import { api } from "./api";
let auth, data;
vi.mock("./AuthContext", () => ({ useAuth: () => auth }));
vi.mock("./api", () => ({
  api: {
    drafts: vi.fn(),
    draft: vi.fn(),
    createDraft: vi.fn(),
    saveDraft: vi.fn(),
    archiveDraft: vi.fn(),
    addDraftChapter: vi.fn(),
    saveDraftChapter: vi.fn(),
    removeDraftChapter: vi.fn(),
    reorderDraft: vi.fn(),
  },
}));
const chapter = (id, title, position) => ({
  id,
  title,
  summary: "Summary",
  position,
  revision: 1,
  removed: false,
});
const view = (path = "/studio") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Studio />
    </MemoryRouter>,
  );
const renderAgain = (target) =>
  target.rerender(
    <MemoryRouter>
      <Studio />
    </MemoryRouter>,
  );
beforeEach(() => {
  vi.resetAllMocks();
  auth = { user: { id: "owner-a", kind: "registered" }, csrfToken: "csrf-a" };
  data = {
    story: {
      id: 900000000,
      title: "Story",
      description: "Description",
      genre: "Mystery",
      language: "en",
      state: "draft",
      revision: 1,
    },
    chapters: [],
  };
  api.drafts.mockImplementation(async () => ({
    stories: [data.story],
    nextCursor: null,
  }));
  api.draft.mockImplementation(async () => data);
  api.createDraft.mockImplementation(async (body) => {
    data = {
      story: {
        ...data.story,
        title: body.title,
        description: body.description,
        genre: body.genre,
        language: body.language,
      },
      chapters: [],
    };
    return { ...data, replayed: false };
  });
  api.saveDraft.mockImplementation(async (_id, body) => {
    data = {
      ...data,
      story: {
        ...data.story,
        title: body.title,
        description: body.description,
        genre: body.genre,
        language: body.language,
        revision: data.story.revision + 1,
      },
    };
    return data;
  });
  api.archiveDraft.mockImplementation(async () => {
    data = {
      ...data,
      story: {
        ...data.story,
        state: "archived",
        revision: data.story.revision + 1,
      },
    };
    return data;
  });
});
afterEach(cleanup);
it("shows permission errors and signed-out/offline state without a creator write bypass", async () => {
  api.drafts.mockRejectedValueOnce(
    Object.assign(Error("Active creator access required"), { status: 403 }),
  );
  const target = view();
  await screen.findByText("Active creator access required");
  expect(
    screen.queryByRole("button", { name: "Create draft story" }),
  ).toBeNull();
  auth = { user: null };
  renderAgain(target);
  expect(screen.getByText(/Studio is unavailable offline/)).toBeTruthy();
});
it("creates a private draft using scoped metadata and a stable request UUID", async () => {
  api.drafts.mockResolvedValueOnce({ stories: [], nextCursor: null });
  view();
  await screen.findByText("No draft stories yet.");
  fireEvent.change(screen.getByLabelText("Story title"), {
    target: { value: "New story" },
  });
  fireEvent.change(screen.getByLabelText("Genre"), {
    target: { value: "Mystery" },
  });
  fireEvent.click(screen.getByText("Create draft story"));
  await screen.findByRole("region", { name: "Draft editor" });
  await screen.findByRole("heading", { name: "New story" });
  const [body, signal, scope] = api.createDraft.mock.calls[0];
  expect(body).toMatchObject({
    title: "New story",
    genre: "Mystery",
    language: "en",
    requestId: expect.any(String),
  });
  expect(Object.hasOwn(body, "ownerId")).toBe(false);
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(scope.user.id).toBe("owner-a");
});
it("marks unsaved metadata and saves with the rendered story revision", async () => {
  view("/studio?story=900000000");
  await screen.findByLabelText("Story title");
  fireEvent.change(screen.getByLabelText("Story title"), {
    target: { value: "Edited" },
  });
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  expect(screen.getByText("Add chapter").disabled).toBe(true);
  fireEvent.click(screen.getByText("Save story"));
  await screen.findByText("Draft saved.");
  expect(api.saveDraft.mock.calls[0][1]).toMatchObject({
    title: "Edited",
    expectedRevision: 1,
  });
  expect(screen.queryByText("Unsaved changes")).toBeNull();
});
it("shows conflict state and preserves local edits for explicit review/save against a fresh revision", async () => {
  view("/studio?story=900000000");
  await screen.findByLabelText("Story title");
  const remote = {
    ...data,
    story: { ...data.story, title: "Remote title", revision: 2 },
  };
  api.saveDraft.mockRejectedValueOnce(
    Object.assign(Error("This draft changed"), {
      status: 409,
      current: remote,
    }),
  );
  fireEvent.change(screen.getByLabelText("Story title"), {
    target: { value: "My local title" },
  });
  fireEvent.click(screen.getByText("Save story"));
  await screen.findByText("Draft changed");
  expect(screen.getByText(/Latest story: Remote title/)).toBeTruthy();
  expect(api.saveDraft).toHaveBeenCalledOnce();
  data = remote;
  fireEvent.click(screen.getByText("Review My Changes on Latest"));
  await screen.findByText(/Your edits are ready for review/);
  expect(screen.getByLabelText("Story title").value).toBe("My local title");
  expect(api.saveDraft).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText("Save story"));
  await screen.findByText("Draft saved.");
  expect(api.saveDraft.mock.calls[1][1].expectedRevision).toBe(2);
});
it("reorders chapters with a parent guard and confirms soft removal without losing other edits", async () => {
  data.chapters = [chapter(900000000, "One", 1), chapter(900000001, "Two", 2)];
  api.reorderDraft.mockImplementationOnce(async () => {
    data = {
      ...data,
      story: { ...data.story, revision: 2 },
      chapters: [
        { ...data.chapters[1], position: 1, revision: 2 },
        { ...data.chapters[0], position: 2, revision: 2 },
      ],
    };
    return data;
  });
  api.removeDraftChapter.mockImplementationOnce(async () => {
    data = {
      ...data,
      story: { ...data.story, revision: 3 },
      chapters: [{ ...data.chapters[0], position: 1 }],
    };
    return data;
  });
  view("/studio?story=900000000");
  await screen.findByText("Move Two up");
  fireEvent.click(screen.getByText("Move Two up"));
  await screen.findByText("Chapter order saved.");
  expect(api.reorderDraft.mock.calls[0].slice(0, 3)).toEqual([
    "900000000",
    [900000001, 900000000],
    1,
  ]);
  fireEvent.click(screen.getByText("Remove One"));
  fireEvent.click(screen.getByText("Cancel operation"));
  expect(api.removeDraftChapter).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Remove One"));
  fireEvent.click(screen.getByText("Confirm remove chapter"));
  await screen.findByText(/Chapter removed. Its ID/);
  expect(api.removeDraftChapter.mock.calls[0][2]).toEqual({
    expectedRevision: 2,
    expectedStoryRevision: 2,
  });
});
it("keeps the exact story creation identity and fields after an uncertain network response", async () => {
  api.drafts.mockResolvedValue({ stories: [], nextCursor: null });
  api.createDraft.mockRejectedValueOnce(Error("Network interrupted"));
  view();
  await screen.findByText("No draft stories yet.");
  fireEvent.change(screen.getByLabelText("Story title"), {
    target: { value: "Once" },
  });
  fireEvent.change(screen.getByLabelText("Genre"), {
    target: { value: "Mystery" },
  });
  fireEvent.click(screen.getByText("Create draft story"));
  await screen.findByText(/Creation outcome unknown/);
  const first = api.createDraft.mock.calls[0][0];
  expect(screen.getByLabelText("Story title").matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByText("Refresh My Stories"));
  await waitFor(() => expect(api.drafts).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByText("Retry same story creation").disabled).toBe(false),
  );
  fireEvent.click(screen.getByText("Retry same story creation"));
  await screen.findByRole("heading", { name: "Once" });
  expect(api.createDraft.mock.calls[1][0]).toEqual(first);
});
it("retains the exact chapter creation request across uncertain save and server refresh", async () => {
  api.addDraftChapter
    .mockRejectedValueOnce(Error("Lost acknowledgement"))
    .mockImplementationOnce(async () => data);
  view("/studio?story=900000000");
  await screen.findByText("Add chapter");
  fireEvent.click(screen.getByText("Add chapter"));
  const form = screen.getByRole("form", { name: "Add chapter" });
  fireEvent.change(within(form).getByLabelText("Chapter title"), {
    target: { value: "One" },
  });
  fireEvent.click(screen.getByText("Create chapter"));
  await screen.findByText(/Save outcome unknown/);
  const original = api.addDraftChapter.mock.calls[0][1];
  data = {
    ...data,
    story: { ...data.story, revision: 2 },
    chapters: [chapter(900000000, "One", 1)],
  };
  fireEvent.click(screen.getByText("Reload Latest"));
  await screen.findByText(/Latest state loaded/);
  fireEvent.click(screen.getByText("Retry same chapter creation"));
  await screen.findByText("Draft saved.");
  expect(api.addDraftChapter.mock.calls[1][1]).toEqual(original);
  expect(original.expectedStoryRevision).toBe(1);
});
it("aborts and discards a delayed dashboard read after account switching", async () => {
  let finish;
  api.drafts.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const target = view();
  await waitFor(() => expect(api.drafts).toHaveBeenCalledOnce());
  const signal = api.drafts.mock.calls[0][1];
  auth = { user: { id: "owner-b" }, csrfToken: "csrf-b" };
  api.drafts.mockResolvedValue({ stories: [], nextCursor: null });
  renderAgain(target);
  await screen.findByText("No draft stories yet.");
  await act(() => finish({ stories: [data.story], nextCursor: null }));
  expect(signal.aborted).toBe(true);
  expect(screen.queryByText("Open Story")).toBeNull();
});
it("cannot navigate a new account to an old account draft after a delayed creation response", async () => {
  let finish;
  api.createDraft.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  api.drafts.mockResolvedValue({ stories: [], nextCursor: null });
  const target = view();
  await screen.findByText("No draft stories yet.");
  fireEvent.change(screen.getByLabelText("Story title"), {
    target: { value: "Old owner" },
  });
  fireEvent.change(screen.getByLabelText("Genre"), {
    target: { value: "Mystery" },
  });
  fireEvent.click(screen.getByText("Create draft story"));
  await waitFor(() => expect(api.createDraft).toHaveBeenCalledOnce());
  const signal = api.createDraft.mock.calls[0][1];
  auth = { user: { id: "owner-b" }, csrfToken: "csrf-b" };
  renderAgain(target);
  await screen.findByText("No draft stories yet.");
  await act(() => finish(data));
  expect(signal.aborted).toBe(true);
  expect(api.draft).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "Draft editor" })).toBeNull();
});
it("archives only after confirmation and makes archived story/chapter metadata read-only", async () => {
  view("/studio?story=900000000");
  await screen.findByText("Archive story");
  fireEvent.click(screen.getByText("Archive story"));
  fireEvent.click(screen.getByText("Cancel operation"));
  expect(api.archiveDraft).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Archive story"));
  fireEvent.click(screen.getByText("Confirm archive story"));
  await screen.findByText(/Story archived. Its chapters/);
  expect(screen.getByLabelText("Story title").matches(":disabled")).toBe(true);
  expect(screen.queryByText("Save story")).toBeNull();
  expect(screen.queryByText("Add chapter")).toBeNull();
  expect(api.archiveDraft.mock.calls[0][1]).toBe(1);
});
it("rejects malformed Studio IDs before constructing any API path", () => {
  view("/studio?story=..%2F..%2Fauth%2Fsession");
  expect(screen.getByText("Invalid draft link.")).toBeTruthy();
  expect(api.draft).not.toHaveBeenCalled();
});
