import { describe, it, expect } from "vitest";
import {
  EMPTY_QUEUE,
  MAX_UPCOMING,
  MAX_HISTORY,
  queueEntry,
  queueReducer as reduce,
} from "./queue";
const e = (id, chapter = 101) =>
  queueEntry(
    { id: 1, title: "Story" },
    { id: chapter, title: "Chapter" },
    String(id),
  );
const start = () => ({
  current: e("a"),
  upcoming: [e("b"), e("c", 201)],
  history: [],
});
describe("editable occurrence queue", () => {
  it("keeps current stable when prepending Play Next or appending", () => {
    const s = start(),
      n = reduce(s, { type: "enqueue", entries: [e("d")], next: true });
    expect(n.current).toBe(s.current);
    expect(n.upcoming.map((e) => e.id)).toEqual(["d", "b", "c"]);
    expect(
      reduce(n, { type: "enqueue", entries: [e("f")] }).upcoming.at(-1).id,
    ).toBe("f");
    expect(s.upcoming).toHaveLength(2);
  });
  it("allows repeated chapters with distinct stable occurrence IDs", () => {
    const n = reduce(start(), { type: "enqueue", entries: [e("d"), e("f")] });
    expect(n.upcoming.filter((e) => e.chapter.id === 101)).toHaveLength(3);
    expect(reduce(n, { type: "enqueue", entries: [e("d")] })).toBe(n);
    expect(reduce(n, { type: "enqueue", entries: [e("x"), e("x")] })).toBe(n);
  });
  it("removes exactly one occurrence and never the current item", () => {
    const s = start();
    expect(
      reduce(s, { type: "remove", id: "b" }).upcoming.map((e) => e.id),
    ).toEqual(["c"]);
    expect(reduce(s, { type: "remove", id: "a" }).current).toBe(s.current);
  });
  it("reorders by entry ID and ignores boundary, stale and forged moves", () => {
    const s = start();
    expect(
      reduce(s, { type: "move", id: "c", delta: -1 }).upcoming.map((e) => e.id),
    ).toEqual(["c", "b"]);
    for (const action of [
      { id: "b", delta: -1 },
      { id: "c", delta: 1 },
      { id: "missing", delta: 1 },
      { id: "b", delta: 20 },
    ])
      expect(reduce(s, { type: "move", ...action })).toBe(s);
  });
  it("advances distinct entries synchronously and preserves cross-story previous", () => {
    const a = reduce(start(), { type: "next" }),
      b = reduce(a, { type: "next" });
    expect(a.current.id).toBe("b");
    expect(b.current.id).toBe("c");
    expect(b.upcoming).toEqual([]);
    expect(reduce(b, { type: "next" })).toBe(b);
    const prev = reduce(b, { type: "previous" });
    expect(prev.current.id).toBe("b");
    expect(prev.upcoming[0].id).toBe("c");
  });
  it("clear preserves current/history; empty previous/next do nothing", () => {
    const s = reduce(start(), { type: "next" }),
      cleared = reduce(s, { type: "clear" });
    expect(cleared.current).toBe(s.current);
    expect(cleared.history).toBe(s.history);
    expect(cleared.upcoming).toEqual([]);
    expect(reduce(EMPTY_QUEUE, { type: "next" })).toBe(EMPTY_QUEUE);
    expect(reduce(EMPTY_QUEUE, { type: "previous" })).toBe(EMPTY_QUEUE);
  });
  it("starts a queue without a current chapter", () => {
    const s = reduce(EMPTY_QUEUE, { type: "enqueue", entries: [e("a")] });
    expect(reduce(s, { type: "next" }).current.id).toBe("a");
  });
  it("bounds upcoming/history without partial enqueue or discarding a full queue on previous", () => {
    const s = {
      ...start(),
      history: [e("history")],
      upcoming: Array.from({ length: MAX_UPCOMING }, (_, i) => e(i)),
    };
    expect(reduce(s, { type: "enqueue", entries: [e("new")] })).toBe(s);
    expect(reduce(s, { type: "previous" })).toBe(s);
    expect(reduce(s, { type: "next" }).history.length).toBeLessThanOrEqual(
      MAX_HISTORY,
    );
    const n = reduce(s, {
      type: "replace",
      current: s.current,
      upcoming: s.upcoming,
      history: Array.from({ length: 30 }, (_, i) => e(i)),
    });
    expect(n.history).toHaveLength(MAX_HISTORY);
  });
});
