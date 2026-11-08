// Account-local protocol coordinator; media and UI stay in PlayerContext.
export function createProgressSync({
  api,
  session,
  online = () => navigator.onLine,
}) {
  const records = new Map();
  function record(id) {
    if (!records.has(id)) {
      if (records.size >= 128) {
        const disposable = [...records].find(
          ([, r]) => !r.dirty && !r.pending && !r.conflict,
        );
        if (!disposable)
          throw Error(
            "Too many unsynchronized chapters. Resolve saved progress before continuing.",
          );
        records.delete(disposable[0]);
      }
      records.set(id, {
        chapter_id: id,
        revision: 0,
        position_seconds: 0,
        completed: false,
        removed: false,
        dirty: false,
        editVersion: 0,
        pending: null,
        conflict: null,
      });
    }
    return records.get(id);
  }
  function seed(chapter) {
    const r = record(chapter.id),
      revision = chapter.revision ?? 0;
    if (revision < r.revision) return r;
    if (revision > r.revision && (r.dirty || r.pending || r.conflict)) {
      if (!r.conflict || revision > r.conflict.revision)
        r.conflict = {
          chapter_id: chapter.id,
          position_seconds: chapter.position_seconds || 0,
          completed: !!chapter.completed,
          removed: !!chapter.removed,
          revision,
        };
    } else if (!r.dirty && !r.conflict)
      Object.assign(r, {
        revision,
        position_seconds: chapter.position_seconds || 0,
        completed: !!chapter.completed,
        removed: !!chapter.removed,
      });
    return r;
  }
  async function transmit(id, r, operation, keepalive) {
    try {
      const p = operation;
      const data = await api.save(
        id,
        p.position,
        p.completed,
        keepalive,
        {
          ...p.identity,
          expectedRevision: p.expectedRevision,
          action: p.action,
        },
        ...(session ? [session] : []),
      );
      if (!data?.progress || !Number.isSafeInteger(data.progress.revision))
        throw Error(
          "Invalid progress acknowledgement. Refresh before retrying.",
        );
      r.pending = null;
      if (
        data.progress.revision !== data.acknowledgedRevision ||
        data.progress.revision < r.revision ||
        r.conflict?.revision > data.progress.revision
      ) {
        r.conflict =
          r.conflict?.revision > data.progress.revision
            ? r.conflict
            : data.progress.revision < r.revision
              ? {
                  chapter_id: id,
                  revision: r.revision,
                  position_seconds: r.position_seconds,
                  completed: r.completed,
                  removed: !!r.removed,
                }
              : data.progress;
        return { conflict: r.conflict };
      }
      Object.assign(r, data.progress, {
        dirty: r.editVersion !== operation.editVersion,
        conflict: null,
      });
      return { saved: true, progress: data.progress };
    } catch (error) {
      if (error.status === 409 && error.progress) {
        if (
          r.removed &&
          error.progress.removed &&
          r.revision >= error.progress.revision
        ) {
          r.pending = null;
          return { removed: true, progress: { ...r } };
        }
        if (
          error.code === "PROGRESS_CONFLICT" &&
          !error.progress.removed &&
          error.progress.position_seconds === operation.position &&
          error.progress.completed === operation.completed &&
          error.progress.revision >= r.revision
        ) {
          Object.assign(r, error.progress, {
            pending: null,
            conflict: null,
            dirty: r.editVersion !== operation.editVersion,
          });
          return { saved: true, progress: error.progress, equivalent: true };
        }
        r.pending = null;
        r.conflict = error.progress;
        return { conflict: error.progress, code: error.code };
      }
      // An uncertain network outcome retains the exact identity and payload.
      if (error.status && error.status < 500) r.pending = null;
      throw error;
    }
  }
  async function write(
    snapshot,
    keepalive = false,
    { retryOnly = false, resolution = false, expectedConflictRevision } = {},
  ) {
    const { chapterId: id, position, completed, identity } = snapshot,
      r = record(id);
    r.dirty = true;
    if (!online()) return { offline: true };
    if (
      r.removed &&
      !resolution &&
      (!snapshot.reset || (snapshot.baseRevision ?? 0) < r.revision)
    )
      return { removed: true, progress: { ...r } };
    if (r.conflict && !resolution) return { conflict: r.conflict };
    if (r.pending) {
      const previous = r.pending,
        result = await transmit(id, r, previous, keepalive);
      if (
        result.conflict ||
        retryOnly ||
        resolution ||
        (previous.position === position &&
          previous.completed === completed &&
          previous.action ===
            (snapshot.reset && !completed ? "reset" : "update"))
      )
        return result;
    }
    const operation = {
      position,
      completed,
      identity,
      editVersion: snapshot.editVersion ?? r.editVersion,
      expectedRevision: resolution
        ? (expectedConflictRevision ?? r.conflict.revision)
        : r.revision,
      action:
        (snapshot.reset && !completed) ||
        (resolution &&
          ((r.conflict?.completed ?? r.completed) ||
            r.conflict?.removed ||
            r.removed) &&
          !completed)
          ? "reset"
          : "update",
    };
    r.pending = operation;
    return transmit(id, r, operation, keepalive);
  }
  async function refresh(id, signal) {
    const r = record(id);
    if (r.pending) {
      const ack = await transmit(id, r, r.pending, false);
      if (ack.conflict) return ack;
    }
    const { progress } = await api.progressChapter(id, signal, session);
    if (progress.revision < r.revision) return { progress: { ...r } };
    if (r.conflict)
      return {
        conflict: (r.conflict =
          r.conflict.revision > progress.revision ? r.conflict : progress),
      };
    if (progress.revision > r.revision) return { remote: progress };
    return r.dirty ? { remote: progress, unsaved: true } : { progress };
  }
  function adopt(id, state) {
    Object.assign(record(id), state, {
      pending: null,
      conflict: null,
      dirty: false,
    });
  }
  function conflict(id, state) {
    record(id).conflict = state;
    return state;
  }
  const markDirty = (id) => {
    const r = record(id);
    r.editVersion++;
    r.dirty = true;
  };
  return { seed, record, write, refresh, adopt, conflict, markDirty };
}
