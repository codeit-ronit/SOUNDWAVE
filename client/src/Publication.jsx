import { useEffect, useRef, useState, useMemo } from "react";
import { api } from "./api";
import { useAuth } from "./AuthContext";
// Account-keyed children retire late responses and native review media on logout.
export function usePrivateRequests() {
  const live = useRef(true),
    controllers = useRef(new Set());
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      for (const c of controllers.current) c.abort();
    };
  }, []);
  const run = async (fn) => {
    const c = new AbortController();
    controllers.current.add(c);
    try {
      const d = await fn(c.signal);
      if (!live.current || c.signal.aborted)
        throw new DOMException("Retired", "AbortError");
      return d;
    } finally {
      controllers.current.delete(c);
    }
  };
  return { live, run };
}
export default function Publication({ id, scope, disabled = false }) {
  const { live, run } = usePrivateRequests(),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [attest, setAttest] = useState(false),
    request = useRef(null),
    [uncertain, setUncertain] = useState(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      const d = await run((signal) => api.publication(id, signal, scope));
      setData(d);
    } catch (e) {
      if (live.current) setError(e.message);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [id]);
  async function action(kind) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    request.current ??= {
      kind,
      body: {
        expectedRevision: data.publication?.revision ?? 0,
        requestId: crypto.randomUUID(),
        ...(kind === "submit"
          ? { attest, termsVersion: data.termsVersion }
          : {}),
      },
    };
    try {
      const r = request.current;
      const d = await run((signal) =>
        api.publicationAction(id, r.kind, r.body, signal, scope),
      );
      setData(d);
      setMessage("Publication status saved.");
      request.current = null;
      setUncertain(false);
      setAttest(false);
    } catch (e) {
      if (live.current) {
        setError(e.message);
        if (!e.status || e.status >= 500) setUncertain(true);
        else {
          request.current = null;
          setUncertain(false);
        }
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const state = data?.publication?.state ?? "draft";
  return (
    <section className="settings-card" aria-label="Publication">
      <h2>Review and publication</h2>
      <p>
        Current state: <strong>{state}</strong>
      </p>
      <p>
        Every chapter needs a ready MP3. Review covers exact metadata, chapter
        order and media. Withdraw or unpublish before edits; changed content
        needs a new review.
      </p>
      <p>
        Unpublishing blocks new server reads. Previously downloaded or buffered
        copies cannot be recalled. Listening records remain.
      </p>
      {data?.publication?.decisionNote && (
        <p>Review decision: {data.publication.decisionNote}</p>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => void load()}
      >
        Refresh publication
      </button>
      {!data && busy && <p role="status">Loading publication…</p>}
      {data && (
        <fieldset disabled={busy || disabled}>
          <legend>Publication actions</legend>
          {uncertain ? (
            <button onClick={() => void action(request.current.kind)}>
              Retry same publication request
            </button>
          ) : (
            <>
              {[
                "draft",
                "rejected",
                "withdrawn",
                "unpublished",
                "revoked",
              ].includes(state) && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={attest}
                      onChange={(e) => setAttest(e.target.checked)}
                    />{" "}
                    I own or have permission to distribute this story and all
                    its audio under {data.termsVersion}. This is my declaration,
                    not independent rights verification.
                  </label>
                  <button
                    className="button primary"
                    disabled={!attest}
                    onClick={() => void action("submit")}
                  >
                    Submit for review
                  </button>
                </>
              )}
              {["submitted", "approved"].includes(state) && (
                <button
                  className="button secondary"
                  onClick={() => void action("withdraw")}
                >
                  Withdraw review
                </button>
              )}
              {(state === "approved" ||
                (state === "unpublished" &&
                  data.publication?.decisionCode === "approved")) && (
                <button
                  className="button primary"
                  onClick={() => void action("publish")}
                >
                  Publish approved story
                </button>
              )}
              {state === "published" && (
                <button
                  className="button secondary"
                  onClick={() => void action("unpublish")}
                >
                  Unpublish story
                </button>
              )}
            </>
          )}
        </fieldset>
      )}
      {data?.audit?.length > 0 && (
        <details>
          <summary>Publication history</summary>
          <ul>
            {data.audit.map((a) => (
              <li key={a.revision}>
                {a.action} · {a.at} {a.note}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
function ReviewAudio({ src, title }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (node) node.setAttribute("src", src);
    return () => {
      if (node) {
        node.pause();
        node.removeAttribute("src");
        node.load();
      }
    };
  }, [src]);
  return (
    <audio
      ref={ref}
      aria-label={`Review audio ${title}`}
      controls
      preload="none"
      src={src}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}
export function Moderation() {
  const auth = useAuth();
  return auth?.user ? (
    <ModeratorAccount key={`${auth.user.id}:${auth.csrfToken}`} auth={auth} />
  ) : (
    <section className="content-section">
      <h1>Moderation</h1>
      <p>Staff sign-in required.</p>
    </section>
  );
}
function ModeratorAccount({ auth }) {
  const scope = useMemo(
      () => ({ user: { id: auth.user.id }, csrfToken: auth.csrfToken }),
      [auth.user.id, auth.csrfToken],
    ),
    { live, run } = usePrivateRequests(),
    [rows, setRows] = useState([]),
    [selected, setSelected] = useState(null),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState(""),
    [code, setCode] = useState("rights_concern"),
    attempt = useRef(null),
    [uncertain, setUncertain] = useState(false),
    media = useRef(null);
  useEffect(
    () => () => {
      if (media.current) {
        media.current.pause();
        media.current.removeAttribute("src");
        media.current.load();
      }
    },
    [],
  );
  async function load(id = selected) {
    setBusy(true);
    setError("");
    setData(null);
    try {
      if (id) {
        const d = await run((signal) =>
          api.moderation(`stories/${id}`, signal, scope),
        );
        setData(d);
        setSelected(id);
      } else {
        const d = await run((signal) => api.moderation("", signal, scope));
        setRows(d.submissions);
        setSelected(null);
      }
    } catch (e) {
      if (live.current) setError(e.message);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load(null);
  }, []);
  async function decide(kind) {
    if (busy) return;
    setBusy(true);
    setError("");
    attempt.current ??= {
      kind,
      body: {
        expectedRevision: data.publication.revision,
        requestId: crypto.randomUUID(),
        code: kind === "approve" ? "approved" : code,
        note: note.trim(),
      },
    };
    try {
      const a = attempt.current,
        d = await run((signal) =>
          api.moderate(selected, a.kind, a.body, signal, scope),
        );
      setData((previous) => ({ ...previous, ...d }));
      attempt.current = null;
      setUncertain(false);
    } catch (e) {
      if (live.current) {
        setError(e.message);
        if (!e.status || e.status >= 500) setUncertain(true);
        else {
          attempt.current = null;
          setUncertain(false);
        }
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <section className="content-section" aria-label="Moderation">
      <h1>Moderation</h1>
      <p>
        Operator-provisioned staff only. Approval does not publish. Self-review
        is forbidden.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Loading moderation…</p>}
      <button
        className="button secondary"
        disabled={busy || uncertain}
        onClick={() => void load(null)}
      >
        Pending submissions
      </button>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => void load()}
      >
        Refresh moderation
      </button>
      {!selected &&
        !busy &&
        (!rows.length ? (
          <p>No pending submissions.</p>
        ) : (
          <ul>
            {rows.map((s) => (
              <li key={s.storyId}>
                <button
                  className="button secondary"
                  onClick={() => void load(s.storyId)}
                >
                  Review {s.title}
                </button>
              </li>
            ))}
          </ul>
        ))}
      {data && (
        <>
          <h2>{data.story?.title ?? "Submission no longer current"}</h2>
          <p>Review state: {data.publication.state}</p>
          <p>{data.story?.description}</p>
          {data.current &&
            ["submitted", "approved", "published"].includes(
              data.publication.state,
            ) &&
            data.chapters.map((c) => (
              <div key={c.id}>
                <h3>{c.title}</h3>
                <ReviewAudio
                  title={c.title}
                  src={`/api/moderation/stories/${selected}/outputs/${c.outputId}/stream`}
                />
              </div>
            ))}
          <fieldset disabled={busy}>
            <legend>Decision</legend>
            <label>
              Decision note
              <textarea
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={uncertain}
              />
            </label>
            <label>
              Reason
              <select
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={uncertain}
              >
                {[
                  "rights_concern",
                  "content_policy",
                  "audio_quality",
                  "metadata_issue",
                ].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            {uncertain ? (
              <button onClick={() => void decide(attempt.current.kind)}>
                Retry same moderation request
              </button>
            ) : (
              <>
                {data.publication.state === "submitted" && (
                  <>
                    <button
                      disabled={!note.trim() || !data.current}
                      onClick={() => void decide("approve")}
                    >
                      Approve submission
                    </button>
                    <button
                      disabled={!note.trim() || !data.current}
                      onClick={() => void decide("reject")}
                    >
                      Reject submission
                    </button>
                  </>
                )}
                {["submitted", "approved", "published", "unpublished"].includes(
                  data.publication.state,
                ) && (
                  <>
                    <button
                      disabled={!note.trim()}
                      onClick={() => void decide("revoke")}
                    >
                      Revoke publication
                    </button>
                    <button
                      disabled={!note.trim()}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Suspend this creator and revoke all their publications? Admin access is required.",
                          )
                        )
                          void decide("suspend");
                      }}
                    >
                      Suspend creator (admin)
                    </button>
                  </>
                )}
              </>
            )}
          </fieldset>
          <h3>Audit history</h3>
          <ul>
            {data.audit.map((a) => (
              <li key={a.revision}>
                {a.action} · {a.at} · {a.actorKind} {a.actorId} {a.note}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
