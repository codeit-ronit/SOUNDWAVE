import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { EMPTY_QUEUE, queueEntry } from "./queue";
import {
  QUEUE_KEY,
  readStoredQueue,
  writeStoredQueue,
  restoreQueue,
  MAX_QUEUE_BYTES,
  clearStoredQueue,
} from "./queueStorage";
const owner = "10000000-0000-4000-8000-000000000001",
  session = { user: { id: owner } },
  story = { id: 1, title: "Public title" },
  chapter = {
    id: 101,
    audio_url: "/api/chapters/101/stream",
    duration_seconds: 30,
  };
let state, api;
beforeEach(() => {
  sessionStorage.clear();
  state = {
    ...EMPTY_QUEUE,
    current: queueEntry(story, chapter),
    upcoming: [queueEntry(story, chapter)],
  };
  api = {
    story: vi.fn().mockResolvedValue({ story }),
    chapters: vi.fn().mockResolvedValue({ chapters: [chapter] }),
  };
});
afterEach(() => vi.restoreAllMocks());
it("stores only bounded references and position, not titles/tokens/progress", () => {
  expect(writeStoredQueue(state, owner, 9.5)).toBe("");
  const raw = sessionStorage.getItem(QUEUE_KEY);
  expect(raw).not.toContain("Public title");
  expect(raw).not.toContain("audio_url");
  expect(readStoredQueue(session).snapshot.position).toBe(9.5);
});
it("rejects another account and clears its stored queue", () => {
  writeStoredQueue(state, owner);
  expect(
    readStoredQueue({ user: { id: "20000000-0000-4000-8000-000000000002" } })
      .snapshot,
  ).toBeNull();
  expect(sessionStorage.getItem(QUEUE_KEY)).toBeNull();
});
it("retains same-owner guest upgrades and offline tab scope", () => {
  writeStoredQueue(state, owner);
  expect(readStoredQueue({ ...session, csrfToken: "new" }).snapshot.owner).toBe(
    owner,
  );
  expect(readStoredQueue({ offline: true, user: null }).snapshot.owner).toBe(
    owner,
  );
});
it.each([
  "{broken",
  "null",
  JSON.stringify({ version: 999 }),
  "x".repeat(MAX_QUEUE_BYTES + 1),
])("recovers from corrupt/versioned/oversized storage", (raw) => {
  sessionStorage.setItem(QUEUE_KEY, raw);
  const read = readStoredQueue(session);
  expect(read.snapshot).toBeNull();
  expect(read.error).toContain("invalid");
  expect(sessionStorage.getItem(QUEUE_KEY)).toBeNull();
});
it("rejects duplicate IDs, invalid references and invalid positions", () => {
  writeStoredQueue(state, owner);
  const valid = JSON.parse(sessionStorage.getItem(QUEUE_KEY));
  for (const broken of [
    { ...valid, upcoming: [valid.current] },
    { ...valid, position: -1 },
    { ...valid, upcoming: [{ ...valid.current, chapterId: "101" }] },
    { ...valid, upcoming: Array(51).fill(valid.current) },
  ]) {
    sessionStorage.setItem(QUEUE_KEY, JSON.stringify(broken));
    expect(readStoredQueue(session).snapshot).toBeNull();
  }
});
it("reports storage failures and leaves the in-memory queue intact", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("quota");
  });
  expect(writeStoredQueue(state, owner)).toContain("in memory");
  expect(state.upcoming).toHaveLength(1);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw Error("disabled");
  });
  expect(readStoredQueue(session).snapshot).toBeNull();
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw Error("disabled");
  });
  expect(clearStoredQueue()).toContain("unavailable");
});
it("validates catalog URLs and titles afresh, preserving duplicate occurrence IDs", async () => {
  writeStoredQueue(state, owner);
  const snapshot = readStoredQueue(session).snapshot;
  const { state: restored } = await restoreQueue(
    snapshot,
    api,
    undefined,
    session,
  );
  expect(restored.current.chapter).toBe(chapter);
  expect(restored.upcoming[0].id).toBe(state.upcoming[0].id);
  expect(api.chapters).toHaveBeenCalledTimes(1);
  expect(api.story).toHaveBeenCalledWith(1, undefined, session);
});
it("prunes missing chapters/stories but retains original storage on a transient failure", async () => {
  writeStoredQueue(state, owner);
  const snapshot = readStoredQueue(session).snapshot;
  api.chapters.mockResolvedValueOnce({ chapters: [] });
  expect((await restoreQueue(snapshot, api)).removed).toBe(2);
  api.story.mockRejectedValueOnce(
    Object.assign(Error("Unavailable"), { status: 503 }),
  );
  await expect(restoreQueue(snapshot, api)).rejects.toThrow("Unavailable");
  expect(readStoredQueue(session).snapshot.current.chapterId).toBe(101);
  api.story.mockRejectedValueOnce(
    Object.assign(Error("Gone"), { status: 404 }),
  );
  expect((await restoreQueue(snapshot, api)).removed).toBe(2);
});

it("offline restoration keeps downloaded occurrences and prunes undownloaded audio", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const match = vi.fn().mockResolvedValue({});
  vi.stubGlobal("caches", { open: vi.fn().mockResolvedValue({ match }) });
  try {
    writeStoredQueue(state, owner);
    const snapshot = readStoredQueue(session).snapshot;
    expect((await restoreQueue(snapshot, api)).state.upcoming).toHaveLength(1);
    match.mockResolvedValue(undefined);
    expect((await restoreQueue(snapshot, api)).removed).toBe(2);
  } finally {
    online.mockRestore();
    vi.unstubAllGlobals();
  }
});
