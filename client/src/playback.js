export function timeLabel(seconds = 0) {
  if (!Number.isFinite(seconds)) return "0:00";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
export function resumeChapter(chapters) {
  return (
    chapters.find((c) => !c.completed && c.position_seconds > 0) ||
    chapters.find((c) => !c.completed) ||
    chapters[0]
  );
}
export function resumePosition(chapter) {
  return chapter.completed
    ? 0
    : Math.min(chapter.position_seconds || 0, chapter.duration_seconds);
}

export const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 2];
export function preferredSpeed() {
  try {
    const speed = Number(localStorage.getItem("soundwave.playbackSpeed"));
    return PLAYBACK_SPEEDS.includes(speed) ? speed : 1;
  } catch {
    return 1;
  }
}

let progressClientId;
let progressSequence = 0;
// Capture before queueing network work. Session storage preserves ordering across a tab refresh.
export function nextProgressVersion() {
  try {
    const storedClient = sessionStorage.getItem("soundwave.progressClient");
    progressClientId =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        storedClient || "",
      )
        ? storedClient
        : progressClientId || crypto.randomUUID();
    const stored = Number(sessionStorage.getItem("soundwave.progressSequence"));
    progressSequence =
      Math.max(
        progressSequence,
        Number.isSafeInteger(stored) && stored >= 0 ? stored : 0,
      ) + 1;
    sessionStorage.setItem("soundwave.progressClient", progressClientId);
    sessionStorage.setItem(
      "soundwave.progressSequence",
      String(progressSequence),
    );
  } catch {
    progressClientId ||= crypto.randomUUID();
    progressSequence++;
  }
  return { clientId: progressClientId, sequence: progressSequence };
}
