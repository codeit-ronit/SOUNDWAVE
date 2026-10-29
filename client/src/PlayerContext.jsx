import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import { resumeChapter, resumePosition } from "./playback";
const PlayerContext = createContext(null);
export const usePlayer = () => useContext(PlayerContext);

export function PlayerProvider({ children }) {
  const audioRef = useRef(null);
  const activeRef = useRef(null);
  const queueRef = useRef([]);
  const selectionRef = useRef(0);
  const desiredPlay = useRef(false);
  const requestVersion = useRef(0);
  const lastSave = useRef(0);
  const saveQueue = useRef(Promise.resolve());
  const mounted = useRef(true);
  const [active, setActive] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.8);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [revision, setRevision] = useState(0);
  const notify = useCallback(() => setRevision((n) => n + 1), []);

  const save = useCallback(
    (completed = false, keepalive = false) => {
      const current = activeRef.current;
      const audio = audioRef.current;
      if (!current || !audio || audio.readyState === 0)
        return Promise.resolve();
      const positionSeconds = completed
        ? current.chapter.duration_seconds
        : Math.min(audio.currentTime || 0, current.chapter.duration_seconds);
      const chapterId = current.chapter.id;
      // Snapshot before switching sources; serialize writes so an older save cannot overwrite a newer one.
      const send = () =>
        api.save(chapterId, positionSeconds, completed, keepalive);
      const pending = keepalive
        ? send()
        : saveQueue.current.catch(() => {}).then(send);
      saveQueue.current = pending;
      return pending
        .then(() => {
          if (mounted.current) {
            setSaveError("");
            notify();
          }
        })
        .catch((err) => {
          if (mounted.current)
            setSaveError(`Progress could not be saved: ${err.message}`);
        });
    },
    [notify],
  );

  const tryPlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !desiredPlay.current) return;
    const version = requestVersion.current;
    try {
      await audio.play();
    } catch (err) {
      if (version !== requestVersion.current || err.name === "AbortError")
        return;
      desiredPlay.current = false;
      setPlaying(false);
      setLoading(false);
      setError(
        err.name === "NotAllowedError"
          ? "Your browser paused playback. Press play to continue."
          : "Audio could not play. Check your connection and retry.",
      );
    }
  }, []);

  const select = useCallback(
    (story, chapter, chapters, autoplay = true) => {
      const audio = audioRef.current;
      requestVersion.current++;
      desiredPlay.current = false;
      audio.pause();
      const current = { story, chapter };
      activeRef.current = current;
      queueRef.current = chapters;
      const start = resumePosition(chapter);
      selectionRef.current = start;
      setActive(current);
      setPosition(start);
      setDuration(chapter.duration_seconds);
      setError("");
      setPlaying(false);
      setLoading(autoplay);
      lastSave.current = Date.now();
      audio.src = chapter.audio_url;
      audio.load();
      desiredPlay.current = autoplay;
      // Calling play in the user's click gesture helps browsers with strict autoplay policies.
      if (autoplay) void tryPlay();
    },
    [tryPlay],
  );

  const playStory = useCallback(
    async (story, chapterId) => {
      const version = ++requestVersion.current;
      setLoading(true);
      setError("");
      try {
        await save();
        const { chapters } = await api.chapters(story.id);
        if (version !== requestVersion.current) return;
        const chapter = chapterId
          ? chapters.find((c) => c.id === chapterId)
          : resumeChapter(chapters);
        if (!chapter) throw new Error("This story has no playable chapters.");
        select(story, chapter, chapters);
      } catch (err) {
        if (version === requestVersion.current) {
          setError(err.message);
          setLoading(false);
        }
      }
    },
    [save, select],
  );

  const move = useCallback(
    async (delta) => {
      const current = activeRef.current;
      if (!current) return;
      const index = queueRef.current.findIndex(
        (c) => c.id === current.chapter.id,
      );
      const chapter = queueRef.current[index + delta];
      if (chapter) await playStory(current.story, chapter.id);
    },
    [playStory],
  );

  useEffect(() => {
    mounted.current = true;
    const audio = audioRef.current;
    audio.volume = 0.8;
    const onMetadata = () => {
      audio.currentTime = Math.min(
        selectionRef.current,
        Number.isFinite(audio.duration) ? audio.duration : selectionRef.current,
      );
      setDuration(
        Number.isFinite(audio.duration)
          ? audio.duration
          : activeRef.current?.chapter.duration_seconds || 0,
      );
      setPosition(audio.currentTime);
      setLoading(false);
    };
    const onTime = () => {
      setPosition(audio.currentTime);
      if (
        Date.now() - lastSave.current >= 10000 &&
        !audio.paused &&
        !audio.ended
      ) {
        lastSave.current = Date.now();
        void save();
      }
    };
    const onPause = () => {
      setPlaying(false);
      if (!audio.ended) void save();
    };
    const onPlay = () => {
      setPlaying(true);
      setLoading(false);
      setError("");
    };
    const onWaiting = () => setLoading(true);
    const onCanPlay = () => setLoading(false);
    const onError = () => {
      setLoading(false);
      setPlaying(false);
      setError("The audio file could not load. Press retry to load it again.");
    };
    const onEnded = async () => {
      const current = activeRef.current;
      desiredPlay.current = false;
      setPlaying(false);
      await save(true);
      // User navigation or manual selection while the save was pending takes priority.
      if (activeRef.current !== current) return;
      const index = queueRef.current.findIndex(
        (c) => c.id === current.chapter.id,
      );
      const next = queueRef.current[index + 1];
      if (next) select(current.story, next, queueRef.current);
    };
    const onPageHide = () => {
      void save(false, true);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void save(false, true);
    };
    const events = {
      loadedmetadata: onMetadata,
      timeupdate: onTime,
      pause: onPause,
      playing: onPlay,
      waiting: onWaiting,
      canplay: onCanPlay,
      error: onError,
      ended: onEnded,
    };
    for (const [name, listener] of Object.entries(events))
      audio.addEventListener(name, listener);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    // Restore from SQLite without attempting autoplay on page load.
    const controller = new AbortController();
    const version = requestVersion.current;
    api
      .progress(controller.signal)
      .then(async ({ continueListening }) => {
        const latest = continueListening[0];
        if (!latest) return;
        const { chapters } = await api.chapters(latest.id, controller.signal);
        if (version !== requestVersion.current || controller.signal.aborted)
          return;
        const chapter = chapters.find((c) => c.id === latest.resume_chapter_id);
        if (chapter) select(latest, chapter, chapters, false);
      })
      .catch((err) => {
        if (err.name !== "AbortError")
          setSaveError(`Listening history could not load: ${err.message}`);
      });
    return () => {
      mounted.current = false;
      controller.abort();
      for (const [name, listener] of Object.entries(events))
        audio.removeEventListener(name, listener);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      audio.pause();
    };
  }, [save, select]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!active) return;
    if (audio.paused) {
      if (audio.ended) {
        audio.currentTime = 0;
        setPosition(0);
      }
      desiredPlay.current = true;
      void tryPlay();
    } else {
      desiredPlay.current = false;
      audio.pause();
    }
  };
  const seek = (value) => {
    const audio = audioRef.current;
    if (!active || audio.readyState === 0) return;
    audio.currentTime = Math.max(0, Math.min(value, duration));
    setPosition(audio.currentTime);
    void save();
  };
  const setVolume = (value) => {
    audioRef.current.volume = value;
    setVolumeState(value);
  };
  const retry = () => {
    if (active) {
      const current = {
        ...active.chapter,
        position_seconds: position,
        completed: false,
      };
      select(active.story, current, queueRef.current);
    }
  };
  const index = active
    ? queueRef.current.findIndex((c) => c.id === active.chapter.id)
    : -1;
  return (
    <PlayerContext.Provider
      value={{
        active,
        playing,
        loading,
        position,
        duration,
        volume,
        error,
        saveError,
        revision,
        notify,
        playStory,
        toggle,
        seek,
        setVolume,
        move,
        retry,
        retrySave: () => save(),
        hasPrevious: index > 0,
        hasNext: index >= 0 && index < queueRef.current.length - 1,
      }}
    >
      <audio ref={audioRef} preload="metadata" />
      {children}
    </PlayerContext.Provider>
  );
}
