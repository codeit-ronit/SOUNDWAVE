import { createContext, useContext, useEffect, useState, useRef } from "react";
import { request, setSessionScope } from "./api";
const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);
let startup;
async function session() {
  let data;
  try {
    data = await request("/auth/session");
  } catch (error) {
    if (error.status !== 401) throw error;
    setSessionScope(null);
    data = await request("/auth/session");
  }
  setSessionScope(data);
  return data;
}
async function bootstrap() {
  if (!navigator.onLine) return { user: null, offline: true };
  let data = await session();
  if (!data.user && data.demoEnabled) {
    data = await request("/auth/demo", { method: "POST" });
    setSessionScope(data);
  }
  return data;
}
export function AuthProvider({ children }) {
  const tabId = useRef(crypto.randomUUID());
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    startup ||= bootstrap().catch((error) => {
      startup = null;
      throw error;
    });
    startup
      .then((data) => {
        if (live) {
          setState(data);
          setError("");
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [attempt]);
  useEffect(() => {
    // Other tabs must discard in-memory private views after an account switch.
    const channel =
      typeof BroadcastChannel === "function"
        ? new BroadcastChannel("soundwave-auth")
        : null;
    if (channel)
      channel.onmessage = (event) => {
        if (event.data?.source === tabId.current) return;
        setSessionScope(null);
        window.location.reload();
      };
    return () => channel?.close();
  }, []);
  async function change(action, body) {
    setSwitching(true);
    try {
      if (!state?.csrfToken) await session();
      let data = await request("/auth/" + action, {
        method: "POST",
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (action === "logout") {
        setSessionScope(null);
        data = await session();
      }
      setSessionScope(data);
      setState(data);
      startup = Promise.resolve(data);
      if ("caches" in window) await caches.delete("soundwave-data-v1");
      if (typeof BroadcastChannel === "function") {
        const c = new BroadcastChannel("soundwave-auth");
        c.postMessage({ source: tabId.current });
        c.close();
      }
    } finally {
      setSwitching(false);
    }
  }
  if (!state)
    return (
      <div className="state" role={error ? "alert" : "status"}>
        <p>{error || "Opening SoundWave…"}</p>
        {error && (
          <button onClick={() => setAttempt((n) => n + 1)}>
            Retry connection
          </button>
        )}
      </div>
    );
  return (
    <AuthContext.Provider value={{ ...state, change, switching }}>
      {children(state)}
    </AuthContext.Provider>
  );
}
export function Account() {
  const auth = useAuth();
  const [open, setOpen] = useState(
      () => new URLSearchParams(location.search).get("signin") === "1",
    ),
    [register, setRegister] = useState(false),
    [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    if (auth.switching) return;
    setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await auth.change(register ? "register" : "login", values);
      setOpen(false);
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <div className="account-controls">
      <span>
        {auth.offline
          ? "Offline listening"
          : auth.user?.displayName || "Guest browsing"}
        {auth.user?.kind === "guest" ? " · Demo" : ""}
      </span>
      {auth.user?.kind === "registered" ? (
        <button
          className="button secondary"
          onClick={() =>
            auth.change("logout").catch((e) => setError(e.message))
          }
        >
          Sign out
        </button>
      ) : (
        <button className="button secondary" onClick={() => setOpen(!open)}>
          Sign in
        </button>
      )}
      {auth.user?.kind === "registered" && !auth.user.emailVerified && (
        <button
          onClick={async () => {
            try {
              const result = await request("/auth/request-verification", {
                method: "POST",
              });
              setError(result.message);
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          Verify email
        </button>
      )}
      {open && (
        <section className="account-panel" aria-label="Your account">
          <h2>{register ? "Create account" : "Sign in"}</h2>
          <form onSubmit={submit}>
            {register && (
              <label>
                Name
                <input
                  name="displayName"
                  autoComplete="name"
                  required
                  maxLength={80}
                />
              </label>
            )}
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                minLength={12}
                maxLength={256}
                required
              />
            </label>
            <button
              className="button primary"
              type="submit"
              disabled={auth.switching}
            >
              {register ? "Create account" : "Sign in"}
            </button>
          </form>
          <button
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register
              ? "Already have an account? Sign in"
              : "Create a new account"}
          </button>
          {!auth.user && auth.demoEnabled && (
            <button
              onClick={() =>
                auth.change("demo").catch((e) => setError(e.message))
              }
            >
              Try demo
            </button>
          )}
          <a href="/account">Forgot password?</a>
          <button onClick={() => setOpen(false)}>Close</button>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
