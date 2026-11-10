import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./AuthContext";
import { api } from "./api";
export default function Creator() {
  const auth = useAuth();
  return auth?.user ? (
    <CreatorAccount key={`${auth.user.id}:${auth.csrfToken}`} auth={auth} />
  ) : (
    <section className="content-section">
      <h1>Creator access</h1>
      <p>
        Sign in with a registered account to manage creator access. Creator
        settings are unavailable offline.
      </p>
    </section>
  );
}
function CreatorAccount({ auth }) {
  const scope = useMemo(
    () => ({ user: { id: auth.user.id }, csrfToken: auth.csrfToken }),
    [auth.user.id, auth.csrfToken],
  );
  const [data, setData] = useState(null),
    [name, setName] = useState(""),
    [bio, setBio] = useState(""),
    [loading, setLoading] = useState(true),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [confirm, setConfirm] = useState(false);
  const live = useRef(true),
    controller = useRef(null),
    busy = useRef(false);
  function accept(result) {
    setData(result);
    setName(result.creator?.displayName || auth.user.displayName || "");
    setBio(result.creator?.bio || "");
  }
  async function load() {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setLoading(true);
    setMessage("");
    setError("");
    setConfirm(false);
    try {
      const result = await api.creator(c.signal, scope);
      if (live.current && !c.signal.aborted) accept(result);
    } catch (e) {
      if (live.current && !c.signal.aborted) setError(e.message);
    } finally {
      if (live.current && !c.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
      controller.current?.abort();
    };
  }, [scope]);
  async function mutate(action) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    setMessage("");
    const c = new AbortController();
    controller.current = c;
    try {
      const result =
        action === "deactivate"
          ? await api.deactivateCreator(c.signal, scope)
          : await api.saveCreator(
              action,
              { displayName: name, bio },
              c.signal,
              scope,
            );
      if (!live.current || c.signal.aborted) return;
      accept(result);
      setConfirm(false);
      setMessage(
        action === "deactivate"
          ? "Creator access deactivated. Your listener data and content remain."
          : action === "activate"
            ? "Creator access active. Uploading and publishing are not available yet."
            : "Creator profile saved.",
      );
    } catch (e) {
      if (live.current && !c.signal.aborted) {
        setError(e.message);
        setConfirm(false);
      }
    } finally {
      busy.current = false;
      if (live.current) setPending(false);
    }
  }
  const status = data?.creator?.status;
  return (
    <section
      className="content-section settings-page"
      aria-label="Creator access"
    >
      <div className="page-intro">
        <div>
          <span className="eyebrow">CREATE ON SOUNDWAVE</span>
          <h1>Creator access</h1>
          <p>A private creator identity linked to your SoundWave account.</p>
        </div>
      </div>
      <p className="settings-note">
        Registered accounts can activate creator access immediately. This grants
        no admin privileges. Uploading, story editing and publishing are not
        available in this milestone.
      </p>
      <button
        className="button secondary"
        disabled={loading || pending}
        onClick={() => void load()}
      >
        Refresh creator status
      </button>
      {message && <p role="status">{message}</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            className="button secondary"
            disabled={pending || loading}
            onClick={() => void load()}
          >
            Try again
          </button>
        </div>
      )}
      {loading ? (
        <p role="status">Loading creator profile…</p>
      ) : (
        data && (
          <div className="settings-card">
            <p role="status">Status: {status || "not activated"}</p>
            <p>Account role: {data.platformRole}</p>
            {!data.eligible ? (
              <p>
                Demo guests cannot become creators. Register or sign in to a
                registered account first.
              </p>
            ) : (
              <>
                {status === "suspended" && (
                  <p>
                    Creator access is suspended. Contact the operator. Your
                    listening features remain available.
                  </p>
                )}
                {status === "inactive" && (
                  <p>
                    Creator access is inactive. Reactivation retains your
                    creator profile.
                  </p>
                )}
                <form
                  className="settings-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void mutate(status === "active" ? "edit" : "activate");
                  }}
                >
                  <label htmlFor="creator-name">Creator display name</label>
                  <input
                    id="creator-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={80}
                    required
                    disabled={
                      pending || status === "suspended" || status === "inactive"
                    }
                  />
                  <label htmlFor="creator-bio">Creator bio</label>
                  <textarea
                    id="creator-bio"
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    maxLength={1000}
                    rows={4}
                    disabled={
                      pending || status === "suspended" || status === "inactive"
                    }
                  />
                  {status !== "suspended" && (
                    <button
                      className="button primary"
                      disabled={pending}
                      type="submit"
                    >
                      {pending
                        ? "Saving…"
                        : status === "active"
                          ? "Save creator profile"
                          : status === "inactive"
                            ? "Reactivate creator access"
                            : "Activate creator access"}
                    </button>
                  )}
                </form>
                {status === "active" && (
                  <button
                    className="button secondary"
                    disabled={pending}
                    onClick={() => setConfirm(true)}
                  >
                    Deactivate creator access
                  </button>
                )}
                {confirm && (
                  <div role="group" aria-label="Confirm creator deactivation">
                    <p>
                      Deactivate creator access? Your listener data, creator
                      profile and owned content remain.
                    </p>
                    <button
                      className="button secondary"
                      disabled={pending}
                      onClick={() => setConfirm(false)}
                    >
                      Cancel deactivation
                    </button>
                    <button
                      className="button secondary"
                      disabled={pending}
                      onClick={() => void mutate("deactivate")}
                    >
                      Confirm deactivation
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )
      )}
    </section>
  );
}
