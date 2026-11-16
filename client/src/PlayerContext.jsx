import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import { createProgressSync } from "./progressSync";
import { usePreferences } from "./PreferencesContext";
import {
  EMPTY_QUEUE,
  MAX_UPCOMING,
  MAX_HISTORY,
  queueEntry,
  queueReducer,
} from "./queue";
import {
  getQueueEpoch,
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
  const storageEpoch = useRef(getQueueEpoch());
  const enqueueChain = useRef(Promise.resolve());
  const queueGeneration = useRef(0);
  const endedEntry = useRef(null);
  const sync = useRef(null);
  if (!sync.current) sync.current = createProgressSync({ api, session });
  const resetEntry = useRef(null),
    skipPauseSave = useRef(false),
    syncRead = useRef(null),
    syncingRef = useRef(false),
    lastRefresh = useRef(0),
    autoSyncTimer = useRef(null),
    autoSyncPending = useRef(false);
  const [progressConflict, setProgressConflict] = useState(null),
    [syncing, setSyncing] = useState(false),
    [progressStatus, setProgressStatus] = useState("");
  const persistQueue = useCallback((position = 0) => {
    const warning = writeStoredQueue(
      queueRef.current,
      queueOwner.current,
      position,
      storageEpoch.current,
      activeRef.current
        ? sync.current.record(activeRef.current.chapter.id).revision
        : null,
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
    (completed = false, keepalive = false, retryOnly = false) => {
      clearTimeout(seekSaveTimer.current);
      seekSaveTimer.current = null;
      const current = activeRef.current,
        audio = audioRef.current;
      if (!current || !audio || audio.readyState === 0)
        return Promise.resolve();
      const snapshot = {
        chapterId: current.chapter.id,
        editVersion: sync.current.record(current.chapter.id).editVersion,
        baseRevision: sync.current.record(current.chapter.id).revision,
        position: completed
          ? current.chapter.duration_seconds
          : Math.min(audio.currentTime || 0, current.chapter.duration_seconds),
        completed:
          completed || audio.currentTime >= current.chapter.duration_seconds,
        identity: nextProgressVersion(),
        reset: resetEntry.current === current.entryId,
      };
      persistQueue(audio.currentTime);
      const send = () =>
        session && !session.user
          ? Promise.resolve({ offline: true })
          : sync.current.write(snapshot, keepalive, { retryOnly });
      const pending = saveQueue.current.catch(() => {}).then(send);
      saveQueue.current = pending;
      return pending
        .then((result) => {
          if (!mounted.current) return result;
          if (result?.saved) notify();
          if (activeRef.current !== current) return result;
          if (result?.conflict) {
            setProgressConflict({
              entryId: current.entryId,
              server: result.conflict,
            });
            setSaveError("");
            setProgressStatus(
              "Progress conflict — choose which position to keep.",
            );
          } else if (result?.removed) {
            setProgressConflict(null);
            setSaveError("");
            setProgressStatus(
              "Removed from saved history. Playback continues without restoring it.",
            );
          } else if (result?.offline) {
            setSaveError(
              "Offline playback is not synchronized. Reconnect and refresh progress; offline writes are not durably queued.",
            );
            setProgressStatus("Progress not synchronized");
          } else if (result?.saved) {
            if (resetEntry.current === current.entryId)
              resetEntry.current = null;
            setSaveError("");
            setProgressConflict(null);
            setProgressStatus(
              `Saved to account · revision ${result.progress.revision}`,
            );
            persistQueue(audio.currentTime);
          }
          return result;
        })
        .catch((err) => {
          if (mounted.current && activeRef.current === current) {
            setSaveError(`Progress could not be saved: ${err.message}`);
            setProgressStatus("Progress not synchronized");
          }
          return { failed: true };
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
      const known = sync.current.seed(chapter);
      const suppressRestore =
        (chapter.removed || known.removed) &&
        chapter.allowHistoryRestore === false;
      resetEntry.current =
        !suppressRestore &&
        (chapter.completed || chapter.removed || chapter.resetProgress)
          ? entryId
          : null;
      if (resetEntry.current) sync.current.markDirty(chapter.id);
      setProgressConflict(
        known.conflict ? { entryId, server: known.conflict } : null,
      );
      const offline = !navigator.onLine || (session && !session.user);
      setSaveError(
        offline
          ? "Offline playback is not synchronized. Sign in online to refresh account progress."
          : "",
      );
      setProgressStatus(
        offline || known.dirty || known.pending
          ? "Progress not synchronized"
          : known.conflict
            ? "Progress conflict — choose which position to keep."
            : known.revision
              ? `Account progress loaded · revision ${known.revision}`
              : "",
      );
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
        {
          ...entry.chapter,
          position_seconds: 0,
          completed: false,
          resetProgress: true,
          allowHistoryRestore: !completed,
        },
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
      if (skipPauseSave.current) {
        skipPauseSave.current = false;
        return;
      }
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
      if (
        !current ||
        !desiredPlay.current ||
        endedEntry.current === current.entryId
      )
        return;
      endedEntry.current = current.entryId;
      const version = requestVersion.current;
      flushListening();
      analyticsPlaying.current = false;
      desiredPlay.current = false;
      setPlaying(false);
      const outcome = await save(true);
      if (
        !mounted.current ||
        activeRef.current !== current ||
        version !== requestVersion.current
      )
        return;
      if (!outcome?.conflict && autoplayNext.current) move(1, true);
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
      storageEpoch.current = getQueueEpoch();
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
          const remote = {
            chapter_id: entry.chapter.id,
            revision: entry.chapter.revision ?? 0,
            position_seconds: entry.chapter.position_seconds || 0,
            completed: !!entry.chapter.completed,
            removed: !!entry.chapter.removed,
          };
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
          sync.current.seed(entry.chapter);
          if (remote.removed) {
            sync.current.adopt(entry.chapter.id, remote);
            resetEntry.current = null;
            setProgressStatus(
              "Removed from saved history. Explicit replay can restore it.",
            );
          }
          if (!navigator.onLine || session?.offline) {
            sync.current.record(entry.chapter.id).dirty = true;
            setSaveError(
              "Offline playback is not synchronized. Sign in online to refresh progress; offline writes are not durably queued.",
            );
            setProgressStatus("Progress not synchronized");
          }
          if (
            navigator.onLine &&
            session?.user &&
            !remote.removed &&
            Math.abs(snapshot.position - remote.position_seconds) > 0.05
          ) {
            sync.current.conflict(entry.chapter.id, remote);
            setProgressConflict({
              entryId: entry.id,
              server: remote,
              reason:
                snapshot.baseRevision === remote.revision
                  ? "unsaved"
                  : "remote",
            });
            setProgressStatus(
              "Saved device position differs from latest account progress.",
            );
          }
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
      syncRead.current?.abort();
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

  const applyRemote = useCallback(
    (current, state) => {
      if (!mounted.current || activeRef.current !== current) return;
      const audio = audioRef.current;
      desiredPlay.current = false;
      requestVersion.current++;
      if (!audio.paused) {
        skipPauseSave.current = true;
        audio.pause();
      }
      sync.current.adopt(current.chapter.id, state);
      const position = Math.min(
        state.position_seconds,
        current.chapter.duration_seconds,
      );
      const next = {
        ...current,
        chapter: {
          ...current.chapter,
          position_seconds: position,
          completed: state.completed,
          revision: state.revision,
        },
      };
      activeRef.current = next;
      setActive(next);
      queueRef.current = {
        ...queueRef.current,
        current: { ...queueRef.current.current, chapter: next.chapter },
      };
      setQueue(queueRef.current);
      selectionRef.current = position;
      if (audio.readyState > 0) audio.currentTime = position;
      setPosition(position);
      setPlaying(false);
      setLoading(false);
      endedEntry.current = state.completed ? current.entryId : null;
      resetEntry.current = null;
      setProgressConflict(null);
      setSaveError("");
      setProgressStatus(
        `Latest account progress loaded · revision ${state.revision}`,
      );
      persistQueue(position);
      notify();
    },
    [persistQueue, notify],
  );
  const refreshProgress = useCallback(
    async (explicit = false) => {
      const current = activeRef.current;
      if (
        !current ||
        syncingRef.current ||
        (!explicit && Date.now() - lastRefresh.current < 1500)
      )
        return;
      if (!navigator.onLine || (session && !session.user)) {
        setSaveError(
          "Sign in online to refresh account progress. Offline audio remains available.",
        );
        setProgressStatus("Progress not synchronized");
        return;
      }
      clearTimeout(autoSyncTimer.current);
      autoSyncPending.current = false;
      syncingRef.current = true;
      setSyncing(true);
      lastRefresh.current = Date.now();
      const controller = new AbortController();
      syncRead.current?.abort();
      syncRead.current = controller;
      const version = requestVersion.current;
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const read = () => {
          if (controller.signal.aborted)
            throw new DOMException("Refresh canceled", "AbortError");
          return sync.current.refresh(current.chapter.id, controller.signal);
        };
        const pending = saveQueue.current.catch(() => {}).then(read);
        saveQueue.current = pending;
        const aborted = new Promise((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Refresh timed out", "AbortError")),
            { once: true },
          ),
        );
        const result = await Promise.race([pending, aborted]);
        if (
          controller.signal.aborted ||
          !mounted.current ||
          activeRef.current !== current ||
          version !== requestVersion.current
        )
          return;
        const recordAtRead = sync.current.record(current.chapter.id);
        const unsaved =
          result.unsaved ||
          (!result.conflict &&
            !result.remote &&
            audioRef.current.paused &&
            Math.abs(
              audioRef.current.currentTime - recordAtRead.position_seconds,
            ) > 0.05);
        const remote =
          result.conflict ||
          result.remote ||
          (unsaved ? result.progress : null);
        if (remote) {
          const record = sync.current.record(current.chapter.id),
            audio = audioRef.current;
          if (
            !result.conflict &&
            audio.paused &&
            !record.dirty &&
            !record.pending &&
            Math.abs(audio.currentTime - record.position_seconds) < 0.05
          )
            applyRemote(current, remote);
          else {
            sync.current.conflict(current.chapter.id, remote);
            setProgressConflict({
              entryId: current.entryId,
              server: remote,
              reason: unsaved ? "unsaved" : "remote",
            });
            setProgressStatus(
              "Another session saved progress. Your audio has not moved.",
            );
          }
        } else {
          setSaveError("");
          setProgressStatus(
            `Account checked · revision ${result.progress.revision}`,
          );
        }
      } catch (err) {
        if (
          mounted.current &&
          activeRef.current === current &&
          !controller.signal.aborted
        ) {
          setSaveError(`Progress refresh failed: ${err.message}`);
          setProgressStatus("Progress not synchronized");
        }
        if (
          controller.signal.aborted &&
          mounted.current &&
          activeRef.current === current
        ) {
          setSaveError(
            "Progress refresh timed out. Your audio has not moved; refresh to retry.",
          );
          setProgressStatus("Progress not synchronized");
        }
      } finally {
        clearTimeout(timer);
        syncingRef.current = false;
        if (mounted.current) {
          setSyncing(false);
          if (autoSyncPending.current) {
            autoSyncPending.current = false;
            autoSyncTimer.current = setTimeout(
              () => void refreshProgress(),
              1500,
            );
          }
        }
      }
    },
    [applyRemote],
  );
  useEffect(() => {
    const schedule = () => {
      clearTimeout(autoSyncTimer.current);
      autoSyncTimer.current = setTimeout(
        () => {
          if (syncingRef.current) {
            autoSyncPending.current = true;
            return;
          }
          void refreshProgress(true);
        },
        Math.max(0, 1500 - (Date.now() - lastRefresh.current)),
      );
    };
    const visible = () => {
      if (document.visibilityState === "visible") schedule();
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", schedule);
    const offline = () => {
      if (activeRef.current) {
        setSaveError(
          "Offline playback is not synchronized. Reconnect and refresh progress; offline writes are not durably queued.",
        );
        setProgressStatus("Progress not synchronized");
      }
    };
    window.addEventListener("offline", offline);
    return () => {
      clearTimeout(autoSyncTimer.current);
      autoSyncPending.current = false;
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", schedule);
      window.removeEventListener("offline", offline);
    };
  }, [refreshProgress]);
  const resolveProgress = async (choice) => {
    const current = activeRef.current;
    if (
      !current ||
      syncingRef.current ||
      !progressConflict ||
      progressConflict.entryId !== current.entryId
    )
      return;
    if (!navigator.onLine) {
      setSaveError(
        "Reconnect before resolving account progress. Downloaded audio still plays.",
      );
      return;
    }
    const record = sync.current.record(current.chapter.id),
      remote = record.conflict || {
        chapter_id: current.chapter.id,
        revision: record.revision,
        position_seconds: record.position_seconds,
        completed: record.completed,
        removed: !!record.removed,
      };
    const shown = progressConflict.server;
    if (
      remote.revision !== shown.revision ||
      remote.position_seconds !== shown.position_seconds ||
      remote.completed !== shown.completed ||
      !!remote.removed !== !!shown.removed
    ) {
      sync.current.conflict(current.chapter.id, remote);
      setProgressConflict({ entryId: current.entryId, server: remote });
      return;
    }
    if (choice === "removed" && remote.removed) {
      sync.current.adopt(current.chapter.id, remote);
      resetEntry.current = null;
      setProgressConflict(null);
      setSaveError("");
      setProgressStatus(
        "Removed from saved history. Current audio and queue are unchanged.",
      );
      persistQueue(audioRef.current.currentTime);
      return;
    }
    if (choice === "latest") {
      applyRemote(current, remote);
      return;
    }
    syncingRef.current = true;
    setSyncing(true);
    const audio = audioRef.current,
      snapshot = {
        chapterId: current.chapter.id,
        editVersion: record.editVersion,
        baseRevision: record.revision,
        position: Math.min(
          audio.currentTime || 0,
          current.chapter.duration_seconds,
        ),
        completed:
          audio.ended || audio.currentTime >= current.chapter.duration_seconds,
        identity: nextProgressVersion(),
        reset: resetEntry.current === current.entryId,
      };
    if (remote.removed && snapshot.completed) {
      snapshot.position = 0;
      snapshot.completed = false;
      snapshot.reset = true;
    }
    try {
      const pending = saveQueue.current
        .catch(() => {})
        .then(() =>
          sync.current.write(snapshot, false, {
            resolution: true,
            expectedConflictRevision: shown.revision,
          }),
        );
      saveQueue.current = pending;
      const result = await pending;
      if (!mounted.current || activeRef.current !== current) return;
      if (result.conflict)
        setProgressConflict({
          entryId: current.entryId,
          server: result.conflict,
        });
      else if (result.saved) {
        resetEntry.current = null;
        setProgressConflict(null);
        setSaveError("");
        setProgressStatus(
          `Your position saved · revision ${result.progress.revision}`,
        );
        persistQueue(audio.currentTime);
        notify();
      }
    } catch (err) {
      if (mounted.current && activeRef.current === current)
        setSaveError(`Progress could not be saved: ${err.message}`);
    } finally {
      syncingRef.current = false;
      if (mounted.current) {
        setSyncing(false);
        if (autoSyncPending.current) {
          autoSyncPending.current = false;
          autoSyncTimer.current = setTimeout(
            () => void refreshProgress(),
            1500,
          );
        }
      }
    }
  };

  const historyRemoved = useCallback(
    async (progress) => {
      const current = activeRef.current;
      notify();
      if (!current) return;
      try {
        const state =
          progress ||
          (await api.progressChapter(current.chapter.id, undefined, session))
            .progress;
        if (
          !mounted.current ||
          activeRef.current !== current ||
          state.chapter_id !== current.chapter.id ||
          !state.removed ||
          state.revision < sync.current.record(current.chapter.id).revision
        )
          return;
        sync.current.adopt(current.chapter.id, state);
        resetEntry.current = null;
        setProgressConflict(null);
        setSaveError("");
        setProgressStatus(
          "Removed from saved history. Current audio and queue are unchanged.",
        );
        persistQueue(audioRef.current.currentTime);
      } catch (error) {
        if (mounted.current && activeRef.current === current)
          setSaveError(
            `History changed; refresh progress before saving: ${error.message}`,
          );
      }
    },
    [notify, persistQueue],
  );

  const toggle = () => {
    const audio = audioRef.current;
    if (!active) return;
    if (audio.paused) {
      if (
        sync.current.record(activeRef.current.chapter.id).completed ||
        sync.current.record(activeRef.current.chapter.id).removed
      )
        resetEntry.current = activeRef.current.entryId;
      if (audio.ended || audio.currentTime >= duration) {
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
    sync.current.markDirty(activeRef.current.chapter.id);
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
        retrySave: () => save(false, false, true),
        historyRemoved,
        progressConflict,
        progressStatus,
        syncing,
        refreshProgress,
        resolveProgress,
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
