import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./api";
export const DEFAULT_PREFERENCES = Object.freeze({
  playbackSpeed: 1,
  autoplayNext: true,
  defaultVolume: 0.8,
  updatedAt: null,
});
const PreferencesContext = createContext(null);
export const usePreferences = () => useContext(PreferencesContext);
export function PreferencesProvider({ session, children }) {
  return (
    <AccountPreferences
      key={`${session?.user?.id || "anonymous"}:${session?.csrfToken || "offline"}`}
      session={session}
    >
      {children}
    </AccountPreferences>
  );
}
function AccountPreferences({ session, children }) {
  const scope = useMemo(
    () => ({
      csrfToken: session?.csrfToken,
      user: session?.user ? { id: session.user.id } : null,
    }),
    [session?.csrfToken, session?.user?.id],
  );
  const [settings, setSettings] = useState(DEFAULT_PREFERENCES),
    [ready, setReady] = useState(!scope.user),
    [loading, setLoading] = useState(!!scope.user),
    [pending, setPending] = useState(0);
  const [loadError, setLoadError] = useState(""),
    [saveError, setSaveError] = useState("");
  const alive = useRef(true),
    read = useRef(null),
    version = useRef(0),
    queue = useRef(Promise.resolve());
  const reload = useCallback(async () => {
    if (!scope.user) return;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    const at = version.current;
    setLoading(true);
    setLoadError("");
    try {
      const data = await api.settings(controller.signal, scope);
      if (
        !controller.signal.aborted &&
        alive.current &&
        at === version.current
      ) {
        setSettings(data.settings);
        setReady(true);
        setSaveError("");
      }
    } catch (e) {
      if (!controller.signal.aborted && alive.current && at === version.current)
        setLoadError(`Preferences could not load: ${e.message}`);
    } finally {
      if (!controller.signal.aborted && alive.current) setLoading(false);
    }
  }, [scope]);
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
      read.current?.abort();
    };
  }, [reload]);
  const update = useCallback(
    (patch) => {
      if (!alive.current)
        return Promise.reject(
          Error("Account changed before preferences could be saved."),
        );
      if (!scope.user || !navigator.onLine) {
        const e = Error("Preferences need an online account session to save.");
        if (alive.current) setSaveError(e.message);
        return Promise.reject(e);
      }
      const at = ++version.current;
      const captured = { ...patch };
      setPending((n) => n + 1);
      setSaveError("");
      const next = queue.current
        .catch(() => {})
        .then(() => {
          if (!alive.current)
            throw Error("Account changed before preferences could be saved.");
          return api.saveSettings(captured, scope);
        })
        .then((data) => {
          if (alive.current && at === version.current) {
            setSettings(data.settings);
            setReady(true);
            setLoadError("");
          }
          return data.settings;
        })
        .catch((e) => {
          if (alive.current && at === version.current)
            setSaveError(`Preferences could not be saved: ${e.message}`);
          throw e;
        })
        .finally(() => {
          if (alive.current) setPending((n) => n - 1);
        });
      queue.current = next;
      return next;
    },
    [scope],
  );
  return (
    <PreferencesContext.Provider
      value={{
        settings,
        ready,
        loading,
        pending,
        error: saveError || loadError,
        reload,
        update,
      }}
    >
      {children}
    </PreferencesContext.Provider>
  );
}
