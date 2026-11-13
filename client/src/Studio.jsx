import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { api } from "./api";
const blankStory = { title: "", description: "", genre: "", language: "en" },
  blankChapter = { title: "", summary: "" };
const storyFields = (story) => ({
  title: story.title,
  description: story.description,
  genre: story.genre,
  language: story.language,
});
const chapterFields = (chapter) => ({
  title: chapter.title,
  summary: chapter.summary,
});
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function useRequests() {
  const live = useRef(true),
    controllers = useRef(new Set());
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      for (const c of controllers.current) c.abort();
    };
  }, []);
  async function run(fn) {
    const c = new AbortController();
    controllers.current.add(c);
    try {
      const data = await fn(c.signal);
      if (!live.current || c.signal.aborted)
        throw new DOMException("Request retired", "AbortError");
      return data;
    } finally {
      controllers.current.delete(c);
    }
  }
  return { live, run };
}
function StoryFields({ value, onChange, disabled = false }) {
  return (
    <fieldset disabled={disabled} className="settings-form studio-fields">
      <label>
        Story title
        <input
          required
          maxLength={160}
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
        />
      </label>
      <label>
        Description
        <textarea
          maxLength={3000}
          rows={4}
          value={value.description}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
        />
      </label>
      <label>
        Genre
        <input
          required
          maxLength={60}
          value={value.genre}
          onChange={(e) => onChange({ ...value, genre: e.target.value })}
        />
      </label>
      <label>
        Language
        <input
          required
          maxLength={6}
          pattern="[a-z]{2,3}(-[A-Z]{2})?"
          placeholder="en or hi"
          value={value.language}
          onChange={(e) => onChange({ ...value, language: e.target.value })}
        />
      </label>
    </fieldset>
  );
}
function ChapterFields({ value, onChange, disabled = false }) {
  return (
    <fieldset disabled={disabled} className="settings-form studio-fields">
      <label>
        Chapter title
        <input
          required
          maxLength={160}
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
        />
      </label>
      <label>
        Chapter summary
        <textarea
          rows={3}
          maxLength={2000}
          value={value.summary}
          onChange={(e) => onChange({ ...value, summary: e.target.value })}
        />
      </label>
    </fieldset>
  );
}
function AccessLink() {
  return (
    <p>
      <Link to="/creator">Manage creator access</Link>. Only active creators can
      use Studio. Drafts stay private; uploading and publishing are unavailable.
    </p>
  );
}
export default function Studio() {
  const auth = useAuth();
  return auth?.user ? (
    <StudioAccount key={`${auth.user.id}:${auth.csrfToken}`} auth={auth} />
  ) : (
    <section className="content-section">
      <h1>Creator Studio</h1>
      <p>
        Sign in with an active creator account to manage private drafts. Studio
        is unavailable offline.
      </p>
      <AccessLink />
    </section>
  );
}
function StudioAccount({ auth }) {
  const scope = useMemo(
    () => ({ user: { id: auth.user.id }, csrfToken: auth.csrfToken }),
    [auth.user.id, auth.csrfToken],
  );
  const [params, setParams] = useSearchParams(),
    selected = params.get("story");
  if (selected && !/^[1-9]\d{0,8}$/.test(selected))
    return (
      <section className="content-section">
        <h1>Creator Studio</h1>
        <p>Invalid draft link.</p>
        <button className="button secondary" onClick={() => setParams({})}>
          My Stories
        </button>
      </section>
    );
  return selected ? (
    <DraftEditor
      key={selected}
      id={selected}
      scope={scope}
      back={() => setParams({})}
    />
  ) : (
    <Dashboard scope={scope} open={(id) => setParams({ story: String(id) })} />
  );
}
function Dashboard({ scope, open }) {
  const { run, live } = useRequests(),
    [rows, setRows] = useState([]),
    [cursor, setCursor] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [form, setForm] = useState(blankStory),
    [pending, setPending] = useState(false),
    [unknown, setUnknown] = useState(false),
    [blocked, setBlocked] = useState(false);
  const generation = useRef(0),
    busy = useRef(false),
    attempt = useRef(null);
  async function load(append = false) {
    const g = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const data = await run((signal) =>
        api.drafts(
          new URLSearchParams({
            limit: "20",
            ...(append && cursor ? { cursor } : {}),
          }),
          signal,
          scope,
        ),
      );
      if (g !== generation.current) return;
      setRows((old) =>
        append
          ? [
              ...old,
              ...data.stories.filter(
                (s) => !old.some((row) => row.id === s.id),
              ),
            ]
          : data.stories,
      );
      setCursor(data.nextCursor);
      setBlocked(false);
    } catch (e) {
      if (live.current) {
        setError(e.message);
        if (e.status === 403 || e.status === 401) {
          setBlocked(true);
          setRows([]);
        }
      }
    } finally {
      if (live.current && g === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function create(e) {
    e.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    const uncertain = unknown;
    attempt.current ??= { ...form, requestId: crypto.randomUUID() };
    try {
      const data = await run((signal) =>
        api.createDraft(attempt.current, signal, scope),
      );
      attempt.current = null;
      setUnknown(false);
      open(data.story.id);
    } catch (e) {
      if (live.current) {
        setError(e.message);
        if (!e.status || e.status >= 500 || uncertain) {
          setUnknown(true);
        } else attempt.current = null;
      }
    } finally {
      busy.current = false;
      if (live.current) setPending(false);
    }
  }
  return (
    <section className="content-section studio-page" aria-label="My Stories">
      <h1>My Stories</h1>
      <AccessLink />
      <button
        className="button secondary"
        disabled={loading || pending}
        onClick={() => void load()}
      >
        Refresh My Stories
      </button>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            className="button secondary"
            disabled={pending || loading}
            onClick={() => void load()}
          >
            Retry stories
          </button>
        </div>
      )}
      {loading && !rows.length ? (
        <p role="status">Loading stories…</p>
      ) : !rows.length && !error ? (
        <p>No draft stories yet.</p>
      ) : (
        <ul className="studio-list">
          {rows.map((story) => (
            <li key={story.id}>
              <div>
                <strong>{story.title}</strong>
                <span>
                  {story.state === "archived" ? "Archived" : "Draft"} · Revision{" "}
                  {story.revision}
                </span>
              </div>
              <button
                className="button secondary"
                disabled={pending}
                onClick={() => open(story.id)}
              >
                Open {story.title}
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button
          className="button secondary"
          disabled={pending || loading}
          onClick={() => void load(true)}
        >
          Load more stories
        </button>
      )}
      {!blocked && (
        <section className="settings-card" aria-label="Create Story">
          <h2>Create Story</h2>
          <p>Metadata only. No audio is uploaded or published.</p>
          {unknown && (
            <p role="status">
              Creation outcome unknown. Fields are locked; retry the same
              request to resolve it. Refreshing the list does not cancel an
              accepted creation.
            </p>
          )}
          <form onSubmit={create}>
            <StoryFields
              value={form}
              onChange={setForm}
              disabled={pending || unknown || loading || blocked}
            />
            <button className="button primary" disabled={pending || loading}>
              {pending
                ? "Creating…"
                : unknown
                  ? "Retry same story creation"
                  : "Create draft story"}
            </button>
          </form>
        </section>
      )}
    </section>
  );
}
function DraftEditor({ id, scope, back }) {
  const { run, live } = useRequests(),
    [data, setData] = useState(null),
    [form, setForm] = useState(blankStory),
    [mode, setMode] = useState(null),
    [chapterForm, setChapterForm] = useState(blankChapter),
    [loading, setLoading] = useState(true),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [conflict, setConflict] = useState(null),
    [unknown, setUnknown] = useState(false),
    [blocked, setBlocked] = useState(false),
    [confirm, setConfirm] = useState(null);
  const busy = useRef(false),
    attempt = useRef(null),
    operation = useRef(null);
  const dirty = data && !equal(form, storyFields(data.story)),
    chapterDirty =
      mode &&
      (mode === "new" ||
        !equal(
          chapterForm,
          chapterFields(
            data?.chapters.find((c) => c.id === mode) || blankChapter,
          ),
        ));
  function accept(result) {
    setData(result);
    setForm(storyFields(result.story));
    setMode(null);
    setChapterForm(blankChapter);
    setConflict(null);
    setUnknown(false);
    setConfirm(null);
    setBlocked(false);
  }
  async function load(reapply = false) {
    const keepForm = form,
      keepChapter = chapterForm,
      keepMode = mode,
      kind = operation.current;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const latest = await run((signal) => api.draft(id, signal, scope));
      if (unknown && kind === "add") {
        setData(latest);
        setBlocked(false);
        setMessage(
          "Latest state loaded; retry the same chapter creation to resolve its outcome.",
        );
        return;
      }
      accept(latest);
      attempt.current = null;
      if (reapply && latest.story.state === "draft") {
        if (kind === "story") setForm(keepForm);
        else if (
          kind === "add" ||
          (kind === "chapter" && latest.chapters.some((c) => c.id === keepMode))
        ) {
          setMode(keepMode);
          setChapterForm(keepChapter);
        } else
          setMessage(
            "That chapter was removed; its edits cannot be reapplied.",
          );
        if (
          kind === "story" ||
          kind === "add" ||
          (kind === "chapter" && latest.chapters.some((c) => c.id === keepMode))
        )
          setMessage(
            "Your edits are ready for review against the latest revision. Save explicitly to apply them.",
          );
      }
    } catch (e) {
      if (live.current) {
        setError(e.message);
        if (e.status === 403) setBlocked(true);
      }
    } finally {
      if (live.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function mutate(kind, payload) {
    if (busy.current) return;
    busy.current = true;
    operation.current = kind;
    setPending(true);
    setError("");
    setMessage("");
    const uncertain = unknown;
    try {
      let result;
      if (kind === "story")
        result = await run((signal) =>
          api.saveDraft(
            id,
            { ...form, expectedRevision: data.story.revision },
            signal,
            scope,
          ),
        );
      if (kind === "archive")
        result = await run((signal) =>
          api.archiveDraft(id, data.story.revision, signal, scope),
        );
      if (kind === "order")
        result = await run((signal) =>
          api.reorderDraft(id, payload, data.story.revision, signal, scope),
        );
      if (kind === "remove") {
        const row = data.chapters.find((c) => c.id === payload);
        result = await run((signal) =>
          api.removeDraftChapter(
            id,
            payload,
            {
              expectedRevision: row.revision,
              expectedStoryRevision: data.story.revision,
            },
            signal,
            scope,
          ),
        );
      }
      if (kind === "chapter") {
        const row = data.chapters.find((c) => c.id === mode);
        result = await run((signal) =>
          api.saveDraftChapter(
            id,
            mode,
            { ...chapterForm, expectedRevision: row.revision },
            signal,
            scope,
          ),
        );
      }
      if (kind === "add") {
        attempt.current ??= {
          ...chapterForm,
          requestId: crypto.randomUUID(),
          expectedStoryRevision: data.story.revision,
        };
        result = await run((signal) =>
          api.addDraftChapter(id, attempt.current, signal, scope),
        );
      }
      accept(result);
      attempt.current = null;
      setMessage(
        result.chapter?.removed && result.replayed
          ? "Creation acknowledged; that chapter has since been removed."
          : kind === "archive"
            ? "Story archived. Its chapters and IDs remain retained."
            : kind === "remove"
              ? "Chapter removed. Its ID will not be reused."
              : kind === "order"
                ? "Chapter order saved."
                : "Draft saved.",
      );
    } catch (e) {
      if (live.current) {
        setError(e.message);
        setConfirm(null);
        if (e.status === 409 && e.current)
          setConflict({ current: e.current, kind });
        if (!e.status || e.status >= 500 || uncertain) setUnknown(true);
        else attempt.current = null;
        if (e.status === 403) setBlocked(true);
      }
    } finally {
      busy.current = false;
      if (live.current) setPending(false);
    }
  }
  const locked = pending || loading || !!conflict || unknown || blocked,
    archived = data?.story.state === "archived",
    editing = !!mode;
  function move(index, delta) {
    const ids = data.chapters.map((c) => c.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    void mutate("order", ids);
  }
  return (
    <section className="content-section studio-page" aria-label="Draft editor">
      <button
        className="button secondary"
        disabled={pending}
        onClick={() => {
          if (dirty || chapterDirty || unknown) setConfirm("leave");
          else back();
        }}
      >
        My Stories
      </button>
      <AccessLink />
      {error && (
        <div role="alert">
          <p>{error}</p>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {conflict && (
        <div className="settings-card" role="alert">
          <h2>Draft changed</h2>
          <p>
            Your edits were not applied. Latest story:{" "}
            {conflict.current.story.title} · Revision{" "}
            {conflict.current.story.revision} · {conflict.current.story.state}
          </p>
          <p>Latest description: {conflict.current.story.description}</p>
          <p>
            Latest genre/language: {conflict.current.story.genre} /{" "}
            {conflict.current.story.language}
          </p>
          <ol>
            {conflict.current.chapters.map((c) => (
              <li key={c.id}>
                {c.title} · Revision {c.revision} · {c.summary}
              </li>
            ))}
          </ol>
          <p>
            Reload discards local edits. Review keeps your metadata for an
            explicit save against freshly fetched revisions.
          </p>
          <button
            className="button secondary"
            disabled={pending || loading}
            onClick={() => void load()}
          >
            Reload Latest
          </button>
          {["story", "chapter", "add"].includes(conflict.kind) &&
            conflict.current.story.state === "draft" && (
              <button
                className="button secondary"
                disabled={pending || loading}
                onClick={() => void load(true)}
              >
                Review My Changes on Latest
              </button>
            )}
        </div>
      )}
      {unknown && (
        <p role="status">
          Save outcome unknown.{" "}
          {operation.current === "add"
            ? "Retry the same chapter creation; fields stay locked until its outcome is resolved."
            : "Reload latest state before making another change."}
        </p>
      )}
      {!conflict && (
        <button
          className="button secondary"
          disabled={pending || loading || (!unknown && (dirty || chapterDirty))}
          onClick={() => void load()}
        >
          {unknown ? "Reload Latest" : "Refresh draft"}
        </button>
      )}
      {loading && !data ? (
        <p role="status">Loading draft…</p>
      ) : !data ? (
        <p>Draft unavailable. Check creator access or return to My Stories.</p>
      ) : (
        <>
          <h1>{data.story.title}</h1>
          <p role="status">
            {archived ? "Archived" : "Draft"} · Story revision{" "}
            {data.story.revision} · Private
          </p>
          {(dirty || chapterDirty) && <p role="status">Unsaved changes</p>}
          <section className="settings-card" aria-label="Story metadata">
            <h2>Story metadata</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void mutate("story");
              }}
            >
              <StoryFields
                value={form}
                onChange={setForm}
                disabled={locked || archived || editing}
              />
              {!archived && (
                <>
                  <button
                    className="button primary"
                    disabled={locked || editing || !dirty}
                  >
                    Save story
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={locked || editing || !dirty}
                    onClick={() => setForm(storyFields(data.story))}
                  >
                    Discard story edits
                  </button>
                </>
              )}
            </form>
          </section>
          <section className="settings-card" aria-label="Draft chapters">
            <h2>Draft chapters</h2>
            <p>
              No audio is attached. Uploading and publishing are unavailable.
            </p>
            {!data.chapters.length && <p>No draft chapters yet.</p>}
            <ol className="studio-list">
              {data.chapters.map((c, index) => (
                <li key={c.id}>
                  <div>
                    <strong>
                      {c.position}. {c.title}
                    </strong>
                    <span>Revision {c.revision}</span>
                    <p>{c.summary}</p>
                  </div>
                  {!archived && (
                    <div className="studio-actions">
                      <button
                        className="button secondary"
                        disabled={locked || dirty || editing}
                        onClick={() => {
                          setMode(c.id);
                          setChapterForm(chapterFields(c));
                          setMessage("");
                        }}
                      >
                        Edit {c.title}
                      </button>
                      <button
                        className="button secondary"
                        disabled={locked || dirty || editing || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        Move {c.title} up
                      </button>
                      <button
                        className="button secondary"
                        disabled={
                          locked ||
                          dirty ||
                          editing ||
                          index === data.chapters.length - 1
                        }
                        onClick={() => move(index, 1)}
                      >
                        Move {c.title} down
                      </button>
                      <button
                        className="button secondary"
                        disabled={locked || dirty || editing}
                        onClick={() => setConfirm(c.id)}
                      >
                        Remove {c.title}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
            {!archived && !mode && (
              <button
                className="button secondary"
                disabled={locked || dirty || data.chapters.length >= 100}
                onClick={() => {
                  setMode("new");
                  setChapterForm(blankChapter);
                  setMessage("");
                }}
              >
                Add chapter
              </button>
            )}
            {mode && !archived && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void mutate(mode === "new" ? "add" : "chapter");
                }}
                aria-label={mode === "new" ? "Add chapter" : "Edit chapter"}
              >
                <h3>{mode === "new" ? "Add chapter" : "Edit chapter"}</h3>
                <ChapterFields
                  value={chapterForm}
                  onChange={setChapterForm}
                  disabled={locked}
                />
                <button
                  className="button primary"
                  disabled={
                    pending ||
                    loading ||
                    !!conflict ||
                    blocked ||
                    (unknown && operation.current !== "add")
                  }
                >
                  {unknown
                    ? "Retry same chapter creation"
                    : mode === "new"
                      ? "Create chapter"
                      : "Save chapter"}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={locked}
                  onClick={() => {
                    setMode(null);
                    setChapterForm(blankChapter);
                  }}
                >
                  Cancel chapter edits
                </button>
              </form>
            )}
          </section>
          {!archived && (
            <button
              className="button secondary"
              disabled={locked || dirty || editing}
              onClick={() => setConfirm("archive")}
            >
              Archive story
            </button>
          )}
        </>
      )}
      {confirm && (
        <div
          className="settings-card"
          role="group"
          aria-label="Confirm draft operation"
        >
          <p>
            {confirm === "leave"
              ? "Leave Studio and discard local edits? An uncertain request may already have been accepted; leaving loses this tab’s retry key."
              : confirm === "archive"
                ? "Archive this story? It becomes read-only; chapters and IDs are retained."
                : "Remove this chapter? Its ID is retained and cannot be restored."}
          </p>
          <button
            className="button secondary"
            disabled={pending}
            onClick={() => setConfirm(null)}
          >
            Cancel operation
          </button>
          <button
            className="button secondary"
            disabled={pending}
            onClick={() => {
              if (confirm === "leave") back();
              else
                void mutate(
                  confirm === "archive" ? "archive" : "remove",
                  confirm,
                );
            }}
          >
            {confirm === "leave"
              ? "Discard and leave"
              : confirm === "archive"
                ? "Confirm archive story"
                : "Confirm remove chapter"}
          </button>
        </div>
      )}
    </section>
  );
}
