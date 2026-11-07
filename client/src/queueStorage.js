import { EMPTY_QUEUE, MAX_HISTORY, MAX_UPCOMING, queueEntry } from "./queue";
export const QUEUE_KEY = "soundwave.queue.v1";
export const MAX_QUEUE_BYTES = 20000;
// Retired players must not recreate a cleared queue during page-hide/unmount.
let queueEpoch = 0;
export const getQueueEpoch = () => queueEpoch;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
export function clearStoredQueue() {
  queueEpoch++;
  try {
    sessionStorage.removeItem(QUEUE_KEY);
    return "";
  } catch {
    return "Browser storage is unavailable. The queue works in memory only.";
  }
}
export function readStoredQueue(session) {
  if (!session) return { snapshot: null, error: "" };
  try {
    const raw = sessionStorage.getItem(QUEUE_KEY);
    if (!raw) return { snapshot: null, error: "" };
    if (raw.length > MAX_QUEUE_BYTES) throw Error("oversized");
    const s = JSON.parse(raw);
    if (s.version !== 1 || typeof s.owner !== "string" || !uuid.test(s.owner))
      throw Error("version/owner");
    if (session.user?.id !== s.owner && !session.offline) {
      clearStoredQueue();
      return { snapshot: null, error: "" };
    }
    if (
      !Array.isArray(s.upcoming) ||
      !Array.isArray(s.history) ||
      s.upcoming.length > MAX_UPCOMING ||
      s.history.length > MAX_HISTORY ||
      !Number.isFinite(s.position) ||
      s.position < 0 ||
      s.position > 604800
    )
      throw Error("shape");
    if (
      (s.current !== null && (!s.current || typeof s.current !== "object")) ||
      [...s.upcoming, ...s.history].some((e) => !e || typeof e !== "object")
    )
      throw Error("reference");
    const ids = new Set();
    for (const e of [s.current, ...s.upcoming, ...s.history].filter(Boolean)) {
      if (
        !uuid.test(e.id) ||
        ids.has(e.id) ||
        !positive(e.storyId) ||
        !positive(e.chapterId)
      )
        throw Error("reference");
      ids.add(e.id);
    }
    return { snapshot: s, error: "" };
  } catch {
    clearStoredQueue();
    return {
      snapshot: null,
      error:
        "Saved queue was invalid or browser storage is unavailable. Saved playback may still restore; playback controls remain available.",
    };
  }
}
export function writeStoredQueue(
  state,
  owner,
  position = 0,
  epoch = queueEpoch,
) {
  if (epoch !== queueEpoch) return "";
  if (!owner) return "";
  const ref = (e) =>
    e ? { id: e.id, storyId: e.story.id, chapterId: e.chapter.id } : null;
  try {
    const value = JSON.stringify({
      version: 1,
      owner,
      current: ref(state.current),
      upcoming: state.upcoming.map(ref),
      history: state.history.map(ref),
      position: Math.max(
        0,
        Math.min(Number.isFinite(position) ? position : 0, 604800),
      ),
    });
    if (value.length > MAX_QUEUE_BYTES) throw Error("capacity");
    sessionStorage.setItem(QUEUE_KEY, value);
    return "";
  } catch {
    return "Queue changes work in memory, but browser storage could not save them. Refresh may lose your queue.";
  }
}
export async function restoreQueue(snapshot, api, signal, session) {
  const catalog = new Map();
  let removed = 0;
  const resolve = async (ref) => {
    if (!ref) return null;
    if (!catalog.has(ref.storyId)) {
      catalog.set(
        ref.storyId,
        Promise.all([
          api.story(ref.storyId, signal, session),
          api.chapters(ref.storyId, signal, session),
        ]).catch((e) => {
          if (e.status === 404 || (!navigator.onLine && e.status === 503))
            return null;
          throw e;
        }),
      );
    }
    const data = await catalog.get(ref.storyId);
    const chapter = data?.[1].chapters.find((c) => c.id === ref.chapterId);
    if (!chapter) {
      removed++;
      return null;
    }
    if (!navigator.onLine) {
      const cached = await (
        await caches.open("soundwave-audio-v1")
      ).match(chapter.audio_url);
      if (!cached) {
        removed++;
        return null;
      }
    }
    return queueEntry(data[0].story, chapter, ref.id);
  };
  // Bounded sequential validation, at most 71 references and 71 distinct stories.
  const current = await resolve(snapshot.current),
    upcoming = [],
    history = [];
  for (const ref of snapshot.upcoming) {
    const e = await resolve(ref);
    if (e) upcoming.push(e);
  }
  for (const ref of snapshot.history) {
    const e = await resolve(ref);
    if (e) history.push(e);
  }
  return { state: { ...EMPTY_QUEUE, current, upcoming, history }, removed };
}
