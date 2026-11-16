import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ListMusic, ArrowLeft } from "lucide-react";
import { useAuth } from "./AuthContext";
import { api } from "./api";
import { useResource } from "./useResource";
import { Loading, ErrorState, SectionHeading, StoryCard } from "./components";

export default function Playlists() {
  const auth = useAuth();
  if (!auth?.user)
    return (
      <section className="content-section">
        <SectionHeading title="Playlists" />
        <p>
          Sign in or start a demo session to manage private playlists.
          Downloaded stories remain available in Downloads.
        </p>
      </section>
    );
  // An account/session change discards every private view and pending form.
  return (
    <PlaylistSection
      key={auth.csrfToken}
      csrfToken={auth.csrfToken}
      user={auth.user}
    />
  );
}

function PlaylistSection({ csrfToken, user }) {
  const session = useMemo(() => ({ csrfToken, user }), [csrfToken, user]);
  const [params, setParams] = useSearchParams();
  const selected = params.get("playlist");
  const [rows, setRows] = useState([]),
    [nextCursor, setNextCursor] = useState(null);
  const [listLoading, setListLoading] = useState(true),
    [listError, setListError] = useState("");
  const [name, setName] = useState(""),
    [rename, setRename] = useState(""),
    [storyId, setStoryId] = useState("");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false),
    [revision, setRevision] = useState(0);
  const lock = useRef(false),
    mounted = useRef(true),
    listRequest = useRef(null);
  const loadList = useCallback(
    async (cursor = null, append = false) => {
      listRequest.current?.abort();
      const controller = new AbortController();
      listRequest.current = controller;
      setListLoading(true);
      setListError("");
      try {
        const data = await api.playlists(
          cursor ? { cursor } : {},
          controller.signal,
          session,
        );
        if (controller.signal.aborted) return;
        setRows((previous) =>
          append
            ? [
                ...new Map(
                  [...previous, ...data.playlists].map((p) => [p.id, p]),
                ).values(),
              ]
            : data.playlists,
        );
        setNextCursor(data.nextCursor);
      } catch (e) {
        if (!controller.signal.aborted) setListError(e.message);
      } finally {
        if (!controller.signal.aborted) setListLoading(false);
      }
    },
    [session],
  );
  useEffect(() => {
    mounted.current = true;
    void loadList();
    return () => {
      mounted.current = false;
      listRequest.current?.abort();
    };
  }, [loadList]);
  const detail = useResource(
    (signal) =>
      selected
        ? api.playlist(selected, signal, session)
        : Promise.resolve(null),
    [selected, revision, session],
  );
  const catalog = useResource(
    (signal) =>
      selected ? api.stories({ sort: "title" }, signal) : Promise.resolve(null),
    [selected],
  );
  const playlist = detail.data?.playlist;
  useEffect(() => {
    setRename(playlist?.name || "");
  }, [playlist?.id, playlist?.name]);
  useEffect(() => {
    setConfirmDelete(false);
    setStoryId("");
    setError("");
  }, [selected]);
  function open(id) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      id ? next.set("playlist", id) : next.delete("playlist");
      return next;
    });
  }
  async function mutate(action, success, after) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await action();
      if (!mounted.current) return;
      after?.(result);
      setMessage(success);
      setRevision((n) => n + 1);
      await loadList();
    } catch (e) {
      if (mounted.current) setError(e.message);
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const included = new Set(detail.data?.stories.map((s) => s.id) || []);
  return (
    <section
      className="content-section playlists"
      aria-label="Private playlists"
    >
      <SectionHeading title="Playlists" eyebrow="YOUR PRIVATE COLLECTIONS" />
      <p className="playlist-note">
        Group stories for another day. Only your current account can see these
        collections.
      </p>
      <form
        className="playlist-form"
        onSubmit={(event) => {
          event.preventDefault();
          void mutate(
            () => api.createPlaylist(name, session),
            "Playlist created.",
            (result) => {
              setName("");
              open(result.playlist.id);
            },
          );
        }}
      >
        <label>
          Playlist name
          <input
            name="playlistName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={160}
            required
            disabled={busy}
            placeholder="e.g. Evening escapes"
          />
        </label>
        <button className="button primary" disabled={busy} type="submit">
          Create playlist
        </button>
      </form>
      {message && (
        <p role="status" className="playlist-feedback">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="playlist-feedback">
          {error} Your changes were not confirmed. You can try again.
        </p>
      )}
      {!selected ? (
        <>
          {listError && (
            <ErrorState message={listError} retry={() => void loadList()} />
          )}
          {listLoading && <Loading label="Loading playlists…" />}
          {!listLoading && !listError && !rows.length && (
            <div className="state">
              <ListMusic size={28} />
              <h3>No playlists yet</h3>
              <p>
                Create a collection, then add stories to it. Your favorites stay
                in Saved Stories.
              </p>
            </div>
          )}
          <div className="playlist-grid">
            {rows.map((p) => (
              <button
                className="playlist-card"
                key={p.id}
                onClick={() => open(p.id)}
                disabled={busy}
                aria-label={`Open playlist ${p.name}`}
              >
                <ListMusic size={22} />
                <strong>{p.name}</strong>
                <span>
                  {p.storyCount} {p.storyCount === 1 ? "story" : "stories"}
                </span>
              </button>
            ))}
          </div>
          {nextCursor && (
            <button
              className="button secondary"
              disabled={listLoading || busy}
              onClick={() => void loadList(nextCursor, true)}
            >
              Load more playlists
            </button>
          )}
        </>
      ) : (
        <>
          <button
            className="button ghost"
            disabled={busy}
            onClick={() => open(null)}
          >
            <ArrowLeft size={16} />
            All playlists
          </button>
          {detail.loading ? (
            <Loading label="Opening playlist…" />
          ) : detail.error ? (
            <ErrorState message={detail.error} retry={detail.retry} />
          ) : (
            playlist && (
              <div className="playlist-detail" aria-label="Open playlist">
                <h3>{playlist.name}</h3>
                <p className="playlist-note">
                  {playlist.storyCount} / 100 stories · Added in order
                </p>
                <form
                  className="playlist-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void mutate(
                      () => api.renamePlaylist(selected, rename, session),
                      "Playlist renamed.",
                    );
                  }}
                >
                  <label>
                    Rename playlist
                    <input
                      value={rename}
                      onChange={(e) => setRename(e.target.value)}
                      maxLength={160}
                      required
                      disabled={busy}
                    />
                  </label>
                  <button
                    className="button secondary"
                    type="submit"
                    disabled={busy}
                  >
                    Save playlist name
                  </button>
                  <button
                    className="button ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete playlist
                  </button>
                </form>
                {confirmDelete && (
                  <div
                    className="playlist-confirm"
                    role="alertdialog"
                    aria-labelledby="delete-playlist-title"
                  >
                    <h4 id="delete-playlist-title">Delete this playlist?</h4>
                    <p>
                      This removes the collection. Your favorites, stories and
                      downloads stay available.
                    </p>
                    <button
                      className="button secondary"
                      autoFocus
                      disabled={busy}
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel deletion
                    </button>
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          () => api.deletePlaylist(selected, session),
                          "Playlist deleted.",
                          () => open(null),
                        )
                      }
                    >
                      Confirm delete playlist
                    </button>
                  </div>
                )}
                {catalog.loading ? (
                  <Loading label="Loading stories to add…" />
                ) : catalog.error ? (
                  <ErrorState message={catalog.error} retry={catalog.retry} />
                ) : (
                  <form
                    className="playlist-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void mutate(
                        () => api.addPlaylistStory(selected, storyId, session),
                        "Story added to playlist.",
                        () => setStoryId(""),
                      );
                    }}
                  >
                    <label>
                      Story to add
                      <select
                        aria-label="Story to add"
                        value={storyId}
                        onChange={(e) => setStoryId(e.target.value)}
                        required
                        disabled={busy || playlist.storyCount >= 100}
                      >
                        <option value="">Select a story</option>
                        {catalog.data?.stories
                          .filter((s) => !included.has(s.id))
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.title}
                            </option>
                          ))}
                      </select>
                    </label>
                    <button
                      className="button secondary"
                      disabled={busy || !storyId || playlist.storyCount >= 100}
                      type="submit"
                    >
                      Add story to playlist
                    </button>
                  </form>
                )}
                {playlist.storyCount >= 100 && (
                  <p role="status">
                    This playlist is full. Remove a story to add another.
                  </p>
                )}
                {!detail.data.stories.length ? (
                  <p className="state">
                    This playlist is empty. Choose a story above to get started.
                  </p>
                ) : (
                  <div className="story-grid">
                    {detail.data.stories.map((story) => (
                      <div className="playlist-story" key={story.id}>
                        <StoryCard story={story} />
                        <button
                          className="button ghost"
                          disabled={busy}
                          aria-label={`Remove ${story.title} from playlist`}
                          onClick={() =>
                            void mutate(
                              () =>
                                api.removePlaylistStory(
                                  selected,
                                  story.id,
                                  session,
                                ),
                              "Story removed from playlist.",
                            )
                          }
                        >
                          Remove from playlist
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          )}
        </>
      )}
    </section>
  );
}
