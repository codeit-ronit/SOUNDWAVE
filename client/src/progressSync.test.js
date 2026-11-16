import { beforeEach, it, expect, vi } from "vitest";
import { createProgressSync } from "./progressSync";
let api, sync, connected, sequence, remote;
const state = (revision, position_seconds = 0, completed = false) => ({
  chapter_id: 101,
  revision,
  position_seconds,
  completed,
});
const error = (revision, code = "PROGRESS_CONFLICT", completed = false) =>
  Object.assign(Error("Conflict"), {
    status: 409,
    code,
    progress: state(revision, 20, completed),
  });
const snapshot = (position = 5, completed = false) => ({
  chapterId: 101,
  position,
  completed,
  identity: { clientId: "client-a", sequence: ++sequence },
});
beforeEach(() => {
  sequence = 0;
  connected = true;
  remote = state(0);
  api = {
    save: vi.fn(async (id, pos, complete, _keep, v) => ({
      progress: (remote = state(v.expectedRevision + 1, pos, complete)),
      acknowledgedRevision: v.expectedRevision + 1,
    })),
    progressChapter: vi.fn(async () => ({ progress: remote })),
  };
  sync = createProgressSync({
    api,
    session: { user: { id: "owner-a" }, csrfToken: "original" },
    online: () => connected,
  });
  sync.seed({ id: 101, revision: 0, position_seconds: 0, completed: false });
});
it("advances acknowledged revisions and allows intentional backward positions", async () => {
  await sync.write(snapshot(10));
  await sync.write(snapshot(3));
  expect(api.save.mock.calls[1][1]).toBe(3);
  expect(api.save.mock.calls[1][4].expectedRevision).toBe(1);
  expect(sync.record(101).revision).toBe(2);
});
it("blocks ordinary writes after conflict until one explicit conditional resolution", async () => {
  api.save.mockRejectedValueOnce(error(1));
  const result = await sync.write(snapshot());
  expect(result.conflict.revision).toBe(1);
  await sync.write(snapshot(6));
  expect(api.save).toHaveBeenCalledTimes(1);
  await sync.write(snapshot(6), false, { resolution: true });
  expect(api.save.mock.calls[1][4].expectedRevision).toBe(1);
  expect(sync.record(101).conflict).toBeNull();
});
it("retries the exact uncertain operation without replacing its identity or payload", async () => {
  api.save.mockRejectedValueOnce(Error("ACK lost"));
  const original = snapshot(10);
  await expect(sync.write(original)).rejects.toThrow("ACK lost");
  await sync.write(snapshot(20), false, { retryOnly: true });
  expect(api.save.mock.calls[1]).toEqual(api.save.mock.calls[0]);
  expect(sync.record(101).position_seconds).toBe(10);
});
it("acknowledging a previously accepted operation exposes a newer server write as a conflict", async () => {
  api.save.mockResolvedValueOnce({
    progress: state(2, 20),
    acknowledgedRevision: 1,
    replayed: true,
  });
  const result = await sync.write(snapshot());
  expect(result.conflict.revision).toBe(2);
  expect(sync.record(101).revision).toBe(0);
});
it("reuses original account identity for all retries", async () => {
  api.save.mockRejectedValueOnce(Error("network"));
  await expect(sync.write(snapshot())).rejects.toThrow();
  await sync.write(snapshot(), false, { retryOnly: true });
  expect(api.save.mock.calls[1][5]).toEqual({
    user: { id: "owner-a" },
    csrfToken: "original",
  });
});
it("does not send offline writes or erase dirty state on a harmless refresh", async () => {
  connected = false;
  expect((await sync.write(snapshot(8))).offline).toBe(true);
  expect(api.save).not.toHaveBeenCalled();
  connected = true;
  await sync.refresh(101);
  expect(sync.record(101).dirty).toBe(true);
  expect(api.save).not.toHaveBeenCalled();
});
it("refresh discovers remote state without mutating the baseline until adoption", async () => {
  remote = state(2, 20);
  expect((await sync.refresh(101)).remote).toEqual(remote);
  expect(sync.record(101).revision).toBe(0);
  sync.adopt(101, remote);
  expect(sync.record(101).revision).toBe(2);
});
it("a reset is explicit; keep-position reopens a remote completed chapter", async () => {
  sync.conflict(101, state(2, 30, true));
  await sync.write(snapshot(5), false, { resolution: true });
  expect(api.save.mock.calls[0][4]).toMatchObject({
    action: "reset",
    expectedRevision: 2,
  });
});
it("a second writer racing a user decision returns a new conflict without a blind retry", async () => {
  sync.conflict(101, state(1, 20));
  api.save.mockRejectedValueOnce(error(2));
  const result = await sync.write(snapshot(8), false, { resolution: true });
  expect(result.conflict.revision).toBe(2);
  expect(api.save).toHaveBeenCalledTimes(1);
});
it("metadata and old acknowledgements never lower a known revision", async () => {
  sync.adopt(101, state(4, 20));
  sync.seed({ id: 101, revision: 1, position_seconds: 5 });
  expect(sync.record(101).revision).toBe(4);
  api.save.mockResolvedValueOnce({
    progress: state(3, 10),
    acknowledgedRevision: 3,
  });
  expect((await sync.write(snapshot())).conflict.revision).toBe(4);
  expect(sync.record(101).revision).toBe(4);
});
it("an uncertain user decision can be retried exactly after its successful lost acknowledgement", async () => {
  sync.conflict(101, state(1, 20));
  api.save.mockRejectedValueOnce(Error("lost"));
  await expect(
    sync.write(snapshot(8), false, { resolution: true }),
  ).rejects.toThrow();
  const result = await sync.write(snapshot(10), false, { resolution: true });
  expect(result.saved).toBe(true);
  expect(api.save.mock.calls[1]).toEqual(api.save.mock.calls[0]);
});
it("bounds in-memory metadata without discarding unresolved writes", () => {
  for (let id = 1; id <= 128; id++) sync.record(id).dirty = true;
  // Chapter 101 was already counted, so one clean/disposable slot may remain.
  for (const r of [sync.record(101)]) r.dirty = true;
  expect(() => sync.record(999)).toThrow("Too many unsynchronized");
});
it("seeds nonzero revisions before the first write and ignores stale metadata", async () => {
  sync.seed({ id: 101, revision: 4, position_seconds: 12, completed: false });
  await sync.write(snapshot(5));
  expect(api.save.mock.calls[0][4].expectedRevision).toBe(4);
  sync.seed({ id: 101, revision: 3, position_seconds: 2, completed: false });
  expect(sync.record(101).revision).toBe(5);
});
it("equivalent accepted server state needs no conflict dialog or blind retry", async () => {
  api.save.mockRejectedValueOnce(
    Object.assign(Error("Conflict"), {
      status: 409,
      code: "PROGRESS_CONFLICT",
      progress: state(1, 5, false),
    }),
  );
  expect((await sync.write(snapshot(5))).saved).toBe(true);
  expect(api.save).toHaveBeenCalledTimes(1);
  expect(sync.record(101).revision).toBe(1);
});
it("offline dirty state is still reported when reconnect finds no newer remote revision", async () => {
  connected = false;
  await sync.write(snapshot(8));
  connected = true;
  expect((await sync.refresh(101)).unsaved).toBe(true);
  expect(api.save).not.toHaveBeenCalled();
});
it("an older acknowledgement cannot clear a newer local seek intent", async () => {
  let finish;
  api.save.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const pending = sync.write(snapshot(5));
  sync.markDirty(101);
  finish({ progress: state(1, 5), acknowledgedRevision: 1 });
  await pending;
  expect(sync.record(101).revision).toBe(1);
  expect(sync.record(101).dirty).toBe(true);
});
it("a user decision uses the displayed conflict revision, never a later hidden observation", async () => {
  sync.conflict(101, state(3, 20));
  api.save.mockRejectedValueOnce(error(3));
  const result = await sync.write(snapshot(8), false, {
    resolution: true,
    expectedConflictRevision: 2,
  });
  expect(api.save.mock.calls[0][4].expectedRevision).toBe(2);
  expect(result.conflict.revision).toBe(3);
  expect(api.save).toHaveBeenCalledTimes(1);
});
it("a queued snapshot cannot borrow a newer local edit generation", async () => {
  const old = { ...snapshot(5), editVersion: 0 };
  sync.markDirty(101);
  await sync.write(old);
  expect(sync.record(101).dirty).toBe(true);
});
it("removal blocks ordinary writes and queued old reset intents until explicit restoration", async () => {
  sync.adopt(101, { ...state(2, 0), removed: true });
  expect(
    (await sync.write({ ...snapshot(8), baseRevision: 1, reset: true }))
      .removed,
  ).toBe(true);
  expect((await sync.write({ ...snapshot(8), baseRevision: 2 })).removed).toBe(
    true,
  );
  expect(api.save).not.toHaveBeenCalled();
  api.save.mockResolvedValueOnce({
    progress: { ...state(3, 0), removed: false },
    acknowledgedRevision: 3,
  });
  await sync.write({ ...snapshot(0), baseRevision: 2, reset: true });
  expect(api.save.mock.calls[0][4]).toMatchObject({
    action: "reset",
    expectedRevision: 2,
  });
  expect(sync.record(101).removed).toBe(false);
});
it("a tombstone is never mistaken for a harmless equivalent-state conflict", async () => {
  api.save.mockRejectedValueOnce(
    Object.assign(error(2), { progress: { ...state(2, 0), removed: true } }),
  );
  expect((await sync.write(snapshot(0))).conflict.removed).toBe(true);
});
