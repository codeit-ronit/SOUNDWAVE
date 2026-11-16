import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./AuthContext";
import { usePreferences } from "./PreferencesContext";
import { api } from "./api";
import { useResource } from "./useResource";
import { PLAYBACK_SPEEDS } from "./playback";
import { Loading, ErrorState } from "./components";

export default function Settings() {
  const auth = useAuth();
  if (!auth?.user)
    return (
      <section className="content-section">
        <h1>Settings</h1>
        <p>
          Sign in or start a demo session to manage your profile and playback
          preferences. Account settings are unavailable offline.
        </p>
      </section>
    );
  return (
    <AccountSettings key={`${auth.user.id}:${auth.csrfToken}`} auth={auth} />
  );
}
function AccountSettings({ auth }) {
  const preferences = usePreferences();
  const scope = useMemo(
    () => ({ csrfToken: auth.csrfToken, user: { id: auth.user.id } }),
    [auth.csrfToken, auth.user.id],
  );
  const [revision, setRevision] = useState(0);
  const profile = useResource(
    (signal) => api.profile(signal, scope),
    [scope, revision],
  );
  const [name, setName] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [profileMessage, setProfileMessage] = useState("");
  const [draft, setDraft] = useState(preferences.settings),
    [dirty, setDirty] = useState(false),
    [preferencesMessage, setPreferencesMessage] = useState("");
  const alive = useRef(true),
    lock = useRef(false),
    preferencesLock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (profile.data) setName(profile.data.profile.displayName);
  }, [profile.data?.profile.displayName]);
  useEffect(() => {
    if (!dirty) setDraft(preferences.settings);
  }, [preferences.settings, dirty]);
  async function saveProfile(event) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError("");
    setProfileMessage("");
    try {
      const data = await api.saveProfile(name, scope);
      if (!alive.current || !auth.acceptProfile(data.profile, scope.csrfToken))
        return;
      setName(data.profile.displayName);
      setProfileMessage("Profile saved.");
      setRevision((n) => n + 1);
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
    }
  }
  async function savePreferences(event) {
    event.preventDefault();
    if (preferences.pending || preferencesLock.current) return;
    preferencesLock.current = true;
    setPreferencesMessage("");
    try {
      const saved = await preferences.update({
        playbackSpeed: draft.playbackSpeed,
        autoplayNext: draft.autoplayNext,
        defaultVolume: draft.defaultVolume,
      });
      if (alive.current) {
        setDraft(saved);
        setDirty(false);
        setPreferencesMessage("Playback preferences saved.");
      }
    } catch {
      /* The scoped provider supplies the recoverable error. */
    } finally {
      preferencesLock.current = false;
    }
  }
  function edit(key, value) {
    setDirty(true);
    setPreferencesMessage("");
    setDraft((d) => ({ ...d, [key]: value }));
  }
  const identity = profile.data?.profile;
  return (
    <div className="settings-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">YOUR SOUNDWAVE ACCOUNT</span>
          <h1>
            Settings<span>.</span>
          </h1>
          <p>Your profile and playback preferences, saved to your account.</p>
        </div>
      </div>
      <section className="settings-card" aria-label="Profile settings">
        <h2>Profile</h2>
        {profile.loading ? (
          <Loading label="Loading profile…" />
        ) : profile.error ? (
          <ErrorState message={profile.error} retry={profile.retry} />
        ) : (
          identity && (
            <>
              <dl className="settings-identity">
                <dt>Email</dt>
                <dd>{identity.email || "No email — demo session"}</dd>
                <dt>Verification</dt>
                <dd>{identity.emailVerified ? "Verified" : "Not verified"}</dd>
                <dt>Google account</dt>
                <dd>
                  {identity.googleLinked
                    ? "Linked to this account"
                    : "Not linked"}
                </dd>
              </dl>
              <p className="settings-note">
                Email and linked sign-in identities are read-only here.
              </p>
              <form onSubmit={saveProfile} className="settings-form">
                <label htmlFor="settings-name">Display name</label>
                <input
                  id="settings-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={160}
                  disabled={pending || auth.switching}
                  autoComplete="name"
                />
                <span className="settings-note">1–80 characters.</span>
                <button
                  className="button primary"
                  disabled={pending || auth.switching}
                  type="submit"
                >
                  {pending ? "Saving profile…" : "Save profile"}
                </button>
              </form>
            </>
          )
        )}
        {profileMessage && <p role="status">{profileMessage}</p>}
        {error && (
          <p role="alert">{error} You can correct the name or try again.</p>
        )}
      </section>
      <section className="settings-card" aria-label="Playback preferences">
        <h2>Playback preferences</h2>
        {!preferences.error && (
          <button
            className="button secondary"
            type="button"
            onClick={() => {
              setDirty(false);
              setPreferencesMessage("");
              void preferences.reload();
            }}
            disabled={!!preferences.pending}
          >
            Reload saved preferences
          </button>
        )}
        {preferences.loading && <Loading label="Loading preferences…" />}
        {preferences.error && (
          <div role="alert">
            <p>{preferences.error}</p>
            <button
              className="button secondary"
              onClick={() => {
                setDirty(false);
                void preferences.reload();
              }}
              disabled={!!preferences.pending}
            >
              Reload preferences
            </button>
          </div>
        )}
        {preferences.ready && !preferences.loading && (
          <form onSubmit={savePreferences} className="settings-form">
            <label htmlFor="settings-speed">Default playback speed</label>
            <select
              id="settings-speed"
              value={draft.playbackSpeed}
              onChange={(e) => edit("playbackSpeed", Number(e.target.value))}
              disabled={!!preferences.pending || auth.switching}
            >
              {PLAYBACK_SPEEDS.map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={draft.autoplayNext}
                onChange={(e) => edit("autoplayNext", e.target.checked)}
                disabled={!!preferences.pending || auth.switching}
              />
              Automatically play the next chapter
            </label>
            <label htmlFor="settings-volume">Default volume</label>
            <div className="settings-volume">
              <input
                id="settings-volume"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={draft.defaultVolume}
                onChange={(e) => edit("defaultVolume", Number(e.target.value))}
                disabled={!!preferences.pending || auth.switching}
              />
              <output>{Math.round(draft.defaultVolume * 100)}%</output>
            </div>
            <p className="settings-note">
              Saved changes apply without restarting audio. The player's volume
              control is a temporary override. Speed changes in the player also
              save to this account.
            </p>
            <button
              className="button primary"
              disabled={!!preferences.pending || auth.switching}
              type="submit"
            >
              {preferences.pending
                ? "Saving preferences…"
                : "Save playback preferences"}
            </button>
          </form>
        )}
        {preferencesMessage && <p role="status">{preferencesMessage}</p>}
      </section>
    </div>
  );
}
