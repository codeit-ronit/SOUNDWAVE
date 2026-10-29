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
