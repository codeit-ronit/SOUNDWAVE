import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import { usePreferences } from "./PreferencesContext";
import {
  EMPTY_QUEUE,
  MAX_UPCOMING,
  MAX_HISTORY,
  queueEntry,
  queueReducer,
} from "./queue";
import {
  readStoredQueue,
  writeStoredQueue,
  restoreQueue,
} from "./queueStorage";
import {
  resumeChapter,
  resumePosition,
  preferredSpeed,
  PLAYBACK_SPEEDS,
  nextProgressVersion,
} from "./playback";
const PlayerContext = createContext(null);
export const usePlayer = () => useContext(PlayerContext);

export function PlayerProvider({ children, session }) {
  const preferences = usePreferences();
  const autoplayNext = useRef(true);
  const audioRef = useRef(null);
  const activeRef = useRef(null);
  const queueRef = useRef(EMPTY_QUEUE);
  const [queue, setQueue] = useState(EMPTY_QUEUE);
  const [queueReady, setQueueReady] = useState(false);
  const [queueError, setQueueError] = useState("");
  const [queueMessage, setQueueMessage] = useState("");
  const queueOwner = useRef(session?.user?.id || null);
  const enqueueChain = useRef(Promise.resolve());
  const queueGeneration = useRef(0);
  const endedEntry = useRef(null);
  const persistQueue = useCallback((position = 0) => {
    const warning = writeStoredQueue(
      queueRef.current,
      queueOwner.current,
      position,
    );
    if (warning && mounted.current) setQueueError(warning);
  }, []);
  const commitQueue = useCallback(
    (action) => {
      const next = queueReducer(queueRef.current, action);
      queueRef.current = next;
      setQueue(next);
      persistQueue(
        next.current?.id === activeRef.current?.entryId
          ? audioRef.current?.currentTime || 0
          : 0,
      );
      return next;
    },
    [persistQueue],
  );
  const selectionRef = useRef(0);
  const desiredPlay = useRef(false);
  const requestVersion = useRef(0);
  const lastSave = useRef(0);
  const saveQueue = useRef(Promise.resolve());
  const seekSaveTimer = useRef(null);
  const mounted = useRef(true);
  const segmentStart = useRef(null);
  const analyticsPlaying = useRef(false);
  const buffering = useRef(false);
  const [speed, setSpeedState] = useState(() =>
    preferences ? 1 : preferredSpeed(),
  );
  const speedRef = useRef(speed);
  const [sleepDeadline, setSleepDeadline] = useState(null);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const keyboardRef = useRef(null);
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
      clearTimeout(seekSaveTimer.current);
      seekSaveTimer.current = null;
      const current = activeRef.current;
      const audio = audioRef.current;
      if (!current || !audio || audio.readyState === 0)
        return Promise.resolve();
      const positionSeconds = completed
        ? current.chapter.duration_seconds
        : Math.min(audio.currentTime || 0, current.chapter.duration_seconds);
      const chapterId = current.chapter.id;
      persistQueue(audio.currentTime);
      const version = nextProgressVersion();
      // Snapshot before switching sources; serialize writes so an older save cannot overwrite a newer one.
      const send = () =>
        api.save(
          chapterId,
          positionSeconds,
          completed,
          keepalive,
          version,
          ...(session ? [session] : []),
        );
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
    [notify, persistQueue],
  );

  const emitPlayback = useCallback(
    (type, listeningSeconds = 0, keepalive = false) => {
      const current = activeRef.current;
      if (!current || !navigator.onLine) return;
      void api
        .analyticsEvent(
          {
            id: crypto.randomUUID(),
            type,
            chapterId: current.chapter.id,
            listeningSeconds,
            playbackRate: speedRef.current,
          },
          keepalive,
          ...(session ? [session] : []),
        )
        .catch(() => {});
    },
    [],
  );
  const flushListening = useCallback(
    (type = "listening_interval", keepalive = false) => {
      const seconds =
        segmentStart.current === null
          ? 0
          : Math.min(
              60,
              Math.max(0, (performance.now() - segmentStart.current) / 1000),
            );
      segmentStart.current = null;
      if (seconds > 0 || type === "playback_paused")
        emitPlayback(type, seconds, keepalive);
    },
    [emitPlayback],
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
    (story, chapter, entryId, autoplay = true) => {
      const audio = audioRef.current;
      clearTimeout(seekSaveTimer.current);
      seekSaveTimer.current = null;
      requestVersion.current++;
      desiredPlay.current = false;
      if (analyticsPlaying.current) flushListening("playback_paused");
      analyticsPlaying.current = false;
      audio.pause();
      const current = { story, chapter, entryId };
      activeRef.current = current;
      endedEntry.current = null;
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
      persistQueue(start);
      if (autoplay) void tryPlay();
    },
    [tryPlay, flushListening, persistQueue],
  );

  const playStory = useCallback(
    async (story, chapterId) => {
      const version = ++requestVersion.current;
      queueGeneration.current++;
      setLoading(true);
      setError("");
      try {
        await save();
        const { chapters } = await api.chapters(story.id, undefined, session);
        if (!mounted.current || version !== requestVersion.current) return;
        const chapter = chapterId
          ? chapters.find((c) => c.id === chapterId)
          : resumeChapter(chapters);
        if (!chapter) throw new Error("This story has no playable chapters.");
        const index = chapters.indexOf(chapter),
          current = queueEntry(story, chapter);
        commitQueue({
          type: "replace",
          current,
          upcoming: chapters
            .slice(index + 1, index + 1 + MAX_UPCOMING)
            .map((c) => queueEntry(story, c)),
          history: chapters
            .slice(Math.max(0, index - MAX_HISTORY), index)
            .map((c) => queueEntry(story, c)),
        });
        setQueueReady(true);
        setQueueMessage(
          chapters.length - index - 1 > MAX_UPCOMING
            ? "Only the next 50 chapters fit in this device queue."
            : "Story chapter order loaded. Previous upcoming entries were replaced.",
        );
        select(story, chapter, current.id);
      } catch (err) {
        if (version === requestVersion.current) {
          setError(err.message);
          setLoading(false);
        }
      }
    },
    [save, select, commitQueue],
  );

  const move = useCallback(
    (delta, completed = false) => {
      const before = queueRef.current;
      const next = queueReducer(before, {
        type: delta === -1 ? "previous" : "next",
      });
      if (next === before) return;
      // Reserve/consume synchronously. Rapid clicks advance distinct occurrences,
      // and an old completion callback cannot consume another entry afterwards.
      if (!completed) void save();
      commitQueue({ type: "replace", ...next });
      const entry = next.current;
      select(
        entry.story,
        { ...entry.chapter, position_seconds: 0, completed: false },
        entry.id,
      );
    },
    [save, select, commitQueue],
  );

  const enqueue = useCallback(
    (story, chapterId, next = false) => {
      const generation = queueGeneration.current;
      const work = enqueueChain.current
        .catch(() => {})
        .then(async () => {
          if (!mounted.current || generation !== queueGeneration.current)
            return;
          const { chapters } = await api.chapters(story.id, undefined, session);
          if (!mounted.current || generation !== queueGeneration.current)
            return;
          const selected = chapterId
            ? chapters.filter((c) => c.id === chapterId)
            : chapters;
          if (!selected.length)
            throw Error("This chapter is no longer available.");
          if (!navigator.onLine) {
            const cache = await caches.open("soundwave-audio-v1");
            for (const chapter of selected) {
              if (!(await cache.match(chapter.audio_url)))
                throw Error(
                  "Only downloaded chapters can be queued offline. Connect or download this chapter first.",
                );
            }
            if (!mounted.current || generation !== queueGeneration.current)
              return;
          }
          if (selected.length + queueRef.current.upcoming.length > MAX_UPCOMING)
            throw Error(
              "Queue holds at most 50 upcoming chapters. Remove some entries first.",
            );
          commitQueue({
            type: "enqueue",
            next,
            entries: selected.map((c) => queueEntry(story, c)),
          });
          setQueueMessage(
            `${selected.length} chapter${selected.length === 1 ? "" : "s"} ${next ? "will play next" : "added to queue"}.`,
          );
          return true;
        })
        .catch((e) => {
          if (mounted.current && generation === queueGeneration.current)
            setQueueError(e.message);
          return false;
        });
      enqueueChain.current = work;
      return work;
    },
    [commitQueue],
  );
  const editQueue = useCallback(
    (action) => {
      if (action.type === "clear") queueGeneration.current++;
      commitQueue(action);
      setQueueMessage(
        action.type === "clear"
          ? "Upcoming queue cleared. Current playback continues."
          : "Queue updated.",
      );
    },
    [commitQueue],
  );

  useEffect(() => {
    mounted.current = true;
    const audio = audioRef.current;
    audio.volume = 0.8;
    const onMetadata = () => {
      audio.playbackRate = speedRef.current;
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
        flushListening();
        if (!audio.paused && !audio.seeking && !buffering.current)
          segmentStart.current = performance.now();
      }
    };
    const onPause = () => {
      if (analyticsPlaying.current) flushListening("playback_paused");
      analyticsPlaying.current = false;
      setPlaying(false);
      if (!audio.ended) void save();
    };
    const onPlay = () => {
      buffering.current = false;
      if (!analyticsPlaying.current) emitPlayback("playback_started");
      analyticsPlaying.current = true;
      segmentStart.current ??= performance.now();
      setPlaying(true);
      setLoading(false);
      setError("");
    };
    const onWaiting = () => {
      flushListening();
      buffering.current = true;
      setLoading(true);
    };
    const onCanPlay = () => setLoading(false);
    const onError = () => {
      flushListening();
      analyticsPlaying.current = false;
      setLoading(false);
      setPlaying(false);
      setError("The audio file could not load. Press retry to load it again.");
    };
    const onEnded = async () => {
      const current = activeRef.current;
      if (!current || endedEntry.current === current.entryId) return;
      endedEntry.current = current.entryId;
      const version = requestVersion.current;
      flushListening();
      analyticsPlaying.current = false;
      desiredPlay.current = false;
      setPlaying(false);
      await save(true);
      if (
        !mounted.current ||
        activeRef.current !== current ||
        version !== requestVersion.current
      )
        return;
      if (autoplayNext.current) move(1, true);
    };
    const onPageHide = () => {
      flushListening("listening_interval", true);
      void save(false, true);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        flushListening("listening_interval", true);
        if (!audio.paused && !audio.seeking && !buffering.current)
          segmentStart.current = performance.now();
        void save(false, true);
      }
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
      seeking: () => flushListening(),
      seeked: () => {
        if (!audio.paused && !audio.ended && !buffering.current)
          segmentStart.current = performance.now();
      },
    };
    for (const [name, listener] of Object.entries(events))
      audio.addEventListener(name, listener);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    // Restore only catalog-validated references, paused. No private JSON cache.
    const controller = new AbortController();
    const version = requestVersion.current;
    const restoreTimeout = setTimeout(() => {
      controller.abort();
      if (mounted.current && version === requestVersion.current) {
        setQueueError(
          "Queue restoration timed out. Refresh to retry, or play a story to replace it.",
        );
        setQueueReady(true);
      }
    }, 15000);
    async function restore() {
      const { snapshot, error: storageError } = readStoredQueue(session);
      if (storageError) setQueueError(storageError);
      if (snapshot) {
        queueOwner.current = snapshot.owner;
        const { state, removed } = await restoreQueue(
          snapshot,
          api,
          controller.signal,
          session,
        );
        if (controller.signal.aborted || version !== requestVersion.current)
          return;
        queueRef.current = state;
        setQueue(state);
        if (removed)
          setQueueMessage(
            `${removed} unavailable queue entries removed${navigator.onLine ? "" : " from the offline queue"}.`,
          );
        if (state.current) {
          const entry = state.current;
          select(
            entry.story,
            {
              ...entry.chapter,
              position_seconds: snapshot.position,
              completed: false,
            },
            entry.id,
            false,
          );
        } else persistQueue();
        return;
      }
      const { continueListening } =
        session && !session.user
          ? { continueListening: [] }
          : await api.progress(controller.signal);
      const latest = continueListening[0];
      if (!latest) return;
      const { chapters } = await api.chapters(
        latest.id,
        controller.signal,
        session,
      );
      if (controller.signal.aborted || version !== requestVersion.current)
        return;
      const chapter = chapters.find((c) => c.id === latest.resume_chapter_id);
      if (chapter) {
        const index = chapters.indexOf(chapter),
          current = queueEntry(latest, chapter);
        commitQueue({
          type: "replace",
          current,
          upcoming: chapters
            .slice(index + 1, index + 1 + MAX_UPCOMING)
            .map((c) => queueEntry(latest, c)),
          history: chapters
            .slice(Math.max(0, index - MAX_HISTORY), index)
            .map((c) => queueEntry(latest, c)),
        });
        select(latest, chapter, current.id, false);
      }
    }
    void restore()
      .catch((err) => {
        if (!controller.signal.aborted && version === requestVersion.current)
          setQueueError(
            `Saved queue or listening history could not load: ${err.message} Refresh to retry, or play a story to replace it.`,
          );
      })
      .finally(() => {
        clearTimeout(restoreTimeout);
        if (!controller.signal.aborted) setQueueReady(true);
      });
    return () => {
      mounted.current = false;
      queueGeneration.current++;
      clearTimeout(seekSaveTimer.current);
      controller.abort();
      clearTimeout(restoreTimeout);
      for (const [name, listener] of Object.entries(events))
        audio.removeEventListener(name, listener);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      audio.pause();
    };
  }, [
    save,
    select,
    emitPlayback,
    flushListening,
    move,
    persistQueue,
    commitQueue,
  ]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!active) return;
    if (audio.paused) {
      if (audio.ended) {
        endedEntry.current = null;
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
    clearTimeout(seekSaveTimer.current);
    seekSaveTimer.current = setTimeout(() => {
      void save();
    }, 400);
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
      select(active.story, current, active.entryId);
    }
  };
  const setSpeed = (value) => {
    if (!PLAYBACK_SPEEDS.includes(value)) return;
    speedRef.current = value;
    audioRef.current.playbackRate = value;
    setSpeedState(value);
    if (preferences) {
      void preferences.update({ playbackSpeed: value }).catch(() => {});
      return;
    }
    try {
      localStorage.setItem("soundwave.playbackSpeed", String(value));
    } catch {
      /* Private mode/storage restrictions do not block playback. */
    }
  };
  useEffect(() => {
    if (!preferences) return;
    const value = preferences.settings.playbackSpeed;
    speedRef.current = value;
    audioRef.current.playbackRate = value;
    setSpeedState(value);
  }, [preferences?.settings.playbackSpeed]);
  useEffect(() => {
    if (!preferences) return;
    const value = preferences.settings.defaultVolume;
    audioRef.current.volume = value;
    setVolumeState(value);
  }, [preferences?.settings.defaultVolume]);
  useEffect(() => {
    autoplayNext.current = preferences
      ? preferences.ready && preferences.settings.autoplayNext
      : true;
  }, [preferences?.settings.autoplayNext, preferences?.ready]);
  const setSleepTimer = (minutes) => {
    if (![0, 5, 15, 30].includes(minutes)) return;
    setSleepDeadline(minutes ? Date.now() + minutes * 60000 : null);
    setSleepRemaining(minutes * 60);
  };
  useEffect(() => {
    audioRef.current.playbackRate = speedRef.current;
  }, []);
  useEffect(() => {
    if (!sleepDeadline) return;
    const tick = () => {
      const seconds = Math.max(
        0,
        Math.ceil((sleepDeadline - Date.now()) / 1000),
      );
      setSleepRemaining(seconds);
      if (!seconds) {
        desiredPlay.current = false;
        audioRef.current.pause();
        setSleepDeadline(null);
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [sleepDeadline]);
  keyboardRef.current = { toggle, seek, position, active };
  useEffect(() => {
    const keydown = (event) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const target = event.target;
      if (
        target?.isContentEditable ||
        target?.closest?.(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="slider"],[role="textbox"],[role="combobox"]',
        )
      )
        return;
      const controls = keyboardRef.current;
      if (!controls.active) return;
      if (event.code === "Space" || event.key === " ") {
        // Keep native activation for unrelated links/buttons. Playback launchers
        // retain focus after a click, so Space there must toggle the player.
        if (
          target?.closest?.('button,a,[role="button"]') &&
          !target.closest("[data-player-shortcuts]")
        )
          return;
        event.preventDefault();
        if (!event.repeat) controls.toggle();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        controls.seek(
          controls.position + (event.key === "ArrowRight" ? 10 : -10),
        );
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  // UI updates follow the media clock between timeupdate events, without increasing save frequency.
  useEffect(() => {
    if (!playing) return;
    let frame;
    const tick = () => {
      // React detaches the media ref before passive effect cleanup on an account
      // switch. A queued frame can run in that interval.
      if (!audioRef.current) return;
      setPosition(audioRef.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  return (
    <PlayerContext.Provider
      value={{
        speed,
        setSpeed,
        sleepRemaining,
        sleepDeadline,
        setSleepTimer,
        active,
        playing,
        loading,
        position,
        duration,
        volume,
        error,
        saveError,
        preferenceError: preferences?.error || "",
        revision,
        notify,
        playStory,
        toggle,
        seek,
        setVolume,
        move,
        retry,
        retrySave: () => save(),
        queue,
        queueReady,
        queueError,
        queueMessage,
        enqueue,
        editQueue,
        dismissQueueError: () => setQueueError(""),
        hasPrevious:
          queue.history.length > 0 && queue.upcoming.length < MAX_UPCOMING,
        hasNext: queue.upcoming.length > 0,
      }}
    >
      <audio ref={audioRef} preload="metadata" />
      {children}
    </PlayerContext.Provider>
  );
}
