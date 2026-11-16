import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { usePlayer } from "./PlayerContext";
import { api } from "./api";
import { timeLabel } from "./playback";
export default function History() {
  const auth = useAuth();
  return auth?.user ? (
    <HistoryAccount key={`${auth.user.id}:${auth.csrfToken}`} auth={auth} />
  ) : (
    <section className="content-section">
      <h1>Listening history</h1>
      <p>
        Sign in or start a demo session to manage saved history. History is
        unavailable offline.
      </p>
    </section>
  );
}
function HistoryAccount({ auth }) {
  const player = usePlayer(),
    scope = useMemo(
      () => ({ user: { id: auth.user.id }, csrfToken: auth.csrfToken }),
      [auth.user.id, auth.csrfToken],
    );
  const [entries, setEntries] = useState([]),
    [cursor, setCursor] = useState(null),
    [guard, setGuard] = useState(null),
    [loading, setLoading] = useState(true),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [confirm, setConfirm] = useState(null),
    [stale, setStale] = useState(false);
  const alive = useRef(true),
    read = useRef(null),
    mutation = useRef(null),
    generation = useRef(0),
    busy = useRef(false),
    appendRetry = useRef(false);
  async function load(append = false) {
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    const version = ++generation.current;
    setLoading(true);
    setError("");
    appendRetry.current = append;
    try {
      const params = new URLSearchParams({
        limit: "20",
        ...(append && cursor ? { cursor } : {}),
      });
      const data = await api.history(params, controller.signal, scope);
      if (
        !alive.current ||
        controller.signal.aborted ||
        version !== generation.current
      )
        return;
      setEntries((old) =>
        append
          ? [
              ...old,
              ...data.entries.filter(
                (e) => !old.some((r) => r.chapter_id === e.chapter_id),
              ),
            ]
          : data.entries,
      );
      setCursor(data.nextCursor);
      if (!append) {
        setGuard(data.historyRevision);
        setStale(false);
      } else if (data.historyRevision !== guard) setStale(true);
    } catch (e) {
      if (alive.current && !controller.signal.aborted) setError(e.message);
    } finally {
      if (alive.current && !controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      read.current?.abort();
      mutation.current?.abort();
    };
  }, [scope]);
  async function remove() {
    if (busy.current || !confirm) return;
    busy.current = true;
    setPending(true);
    setError("");
    setMessage("");
    const controller = new AbortController();
    mutation.current = controller;
    try {
      const result =
        confirm === "all"
          ? await api.clearHistory(guard, controller.signal, scope)
          : await api.removeHistory(
              confirm.chapter_id,
              confirm.revision,
              controller.signal,
              scope,
            );
      if (!alive.current) return;
      setConfirm(null);
      setMessage(
        confirm === "all"
          ? "Saved history cleared. Analytics and completion markers remain."
          : "Saved history entry removed. Analytics and completion markers remain.",
      );
      await player.historyRemoved(result.progress);
      if (alive.current) await load();
    } catch (e) {
      if (alive.current && !controller.signal.aborted) {
        setError(e.message);
        setConfirm(null);
        if (e.status === 409) setStale(true);
      }
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  return (
    <section
      className="content-section history-page"
      aria-label="Listening history"
    >
      <div className="page-intro">
        <div>
          <span className="eyebrow">YOUR LISTENING</span>
          <h1>Listening history</h1>
          <p>Saved chapter bookmarks, private to your account.</p>
        </div>
      </div>
      <p className="history-policy">
        Removal hides saved entries from History and Continue Listening and
        clears incomplete resume positions. Completion markers, listening
        events, time totals, analytics rollups and backups remain. Playlists,
        downloads and this tab's queue are unchanged. This is not full data
        erasure. Future playback can still record listening analytics. Explicit
        replay can restore a removed chapter.
      </p>
      <div className="history-tools">
        <button
          className="button secondary"
          disabled={pending}
          onClick={() => {
            setConfirm(null);
            void load();
          }}
        >
          Refresh history
        </button>
        <button
          className="button secondary"
          disabled={!entries.length || loading || pending || stale}
          onClick={() => setConfirm("all")}
        >
          Clear saved history
        </button>
      </div>
      {stale && (
        <p role="status">
          History changed. Refresh the list before clearing or retrying removal.
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            className="button secondary"
            disabled={pending || loading}
            onClick={() => void load(stale ? false : appendRetry.current)}
          >
            Try again
          </button>
        </div>
      )}
      {confirm && (
        <div
          className="history-confirm"
          role="group"
          aria-label="Confirm history removal"
        >
          <p>
            {confirm === "all"
              ? "Clear all currently saved history?"
              : "Remove this saved chapter entry?"}{" "}
            Analytics and completion markers remain. Current playback continues.
          </p>
          <button
            className="button secondary"
            disabled={pending}
            onClick={() => setConfirm(null)}
          >
            Cancel removal
          </button>
          <button
            className="button secondary"
            disabled={pending}
            onClick={() => void remove()}
          >
            {pending
              ? "Removing…"
              : confirm === "all"
                ? "Confirm clear history"
                : "Confirm remove chapter"}
          </button>
        </div>
      )}
      {loading && !entries.length ? (
        <p role="status">Loading history…</p>
      ) : !entries.length && !error ? (
        <div className="state">
          <h2>No saved history</h2>
          <p>
            Listen to a chapter to save a bookmark. Previously removed chapters
            require explicit replay to return here.
          </p>
          <Link className="button secondary" to="/">
            Explore stories
          </Link>
        </div>
      ) : (
        <ol className="history-list">
          {entries.map((entry) => (
            <li key={entry.chapter_id}>
              <div>
                <Link to={`/stories/${entry.story_id}`} className="story-title">
                  {entry.story_title}
                </Link>
                <strong>{entry.chapter_title}</strong>
                <span>
                  {timeLabel(entry.position_seconds)} /{" "}
                  {timeLabel(entry.duration_seconds)} ·{" "}
                  {entry.completed ? "Completed" : "In progress"}
                </span>
              </div>
              <div className="history-actions">
                <button
                  className="button secondary"
                  disabled={pending}
                  aria-label={`${entry.completed ? "Replay" : "Resume"} ${entry.chapter_title}`}
                  onClick={() =>
                    player.playStory(
                      entry.story || {
                        id: entry.story_id,
                        title: entry.story_title,
                      },
                      entry.chapter_id,
                    )
                  }
                >
                  {entry.completed ? "Replay" : "Resume"}
                </button>
                <button
                  className="button secondary"
                  disabled={pending || stale}
                  aria-label={`Remove ${entry.chapter_title} from history`}
                  onClick={() => setConfirm(entry)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {cursor && (
        <button
          className="button secondary"
          disabled={loading || pending}
          onClick={() => void load(true)}
        >
          {loading ? "Loading more…" : "Load more history"}
        </button>
      )}
    </section>
  );
}
