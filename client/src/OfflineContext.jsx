import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { api } from "./api";
import {
  publicStory as sanitizeStory,
  publicChapter as sanitizeChapter,
} from "./offlineMetadata";
const AUDIO_CACHE = "soundwave-audio-v1";
const DATA_CACHE = "soundwave-data-v2";
const OfflineContext = createContext(null);
export const useOffline = () => useContext(OfflineContext);
export function OfflineProvider({ children }) {
  const [online, setOnline] = useState(navigator.onLine);
  const [downloads, setDownloads] = useState([]);
  const [pending, setPending] = useState(new Set());
  const [error, setError] = useState("");
  const [installPrompt, setInstallPrompt] = useState(null);
  const [ready, setReady] = useState(false);
  const supported =
    "caches" in window &&
    "serviceWorker" in navigator &&
    window.isSecureContext;
  const refresh = useCallback(async () => {
    if (!supported) return;
    const cache = await caches.open(AUDIO_CACHE);
    const rows = await Promise.all(
      (await cache.keys()).map(async (key) => {
        const response = await cache.match(key);
        try {
          return JSON.parse(
            decodeURIComponent(response.headers.get("X-SoundWave-Metadata")),
          );
        } catch {
          return null;
        }
      }),
    );
    setDownloads(rows.filter(Boolean));
  }, [supported]);
  useEffect(() => {
    const connectivity = () => setOnline(navigator.onLine);
    const beforeInstall = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const installed = () => setInstallPrompt(null);
    window.addEventListener("online", connectivity);
    window.addEventListener("offline", connectivity);
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", installed);
    let live = true;
    if (supported && import.meta.env.PROD) {
      navigator.serviceWorker
        .register("/sw.js")
        .then(() => navigator.serviceWorker.ready)
        .then(() => {
          if (live) setReady(true);
        })
        .catch((err) => {
          if (live) setError(`Offline setup failed: ${err.message}`);
        });
    }
    refresh().catch((err) => {
      if (live) setError(`Downloads could not load: ${err.message}`);
    });
    return () => {
      live = false;
      window.removeEventListener("online", connectivity);
      window.removeEventListener("offline", connectivity);
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", installed);
    };
  }, [supported, refresh]);
  const download = async (story, chapter) => {
    if (pending.has(chapter.id)) return;
    setPending((p) => new Set(p).add(chapter.id));
    setError("");
    try {
      if (!ready)
        throw new Error(
          "Offline setup is not ready yet. Open the production app in a supported browser.",
        );
      const response = await fetch(chapter.audio_url, { cache: "no-store" });
      const size = Number(response.headers.get("Content-Length"));
      if (
        response.status !== 200 ||
        response.headers.has("Content-Range") ||
        !response.headers.get("Content-Type")?.startsWith("audio/wav") ||
        !Number.isSafeInteger(size) ||
        size < 44 ||
        size > 25 * 1024 * 1024
      )
        throw new Error(
          "The server did not return a complete supported audio file.",
        );
      const estimate = await navigator.storage?.estimate?.();
      if (estimate?.quota && estimate.quota - estimate.usage < size)
        throw new Error("Not enough browser storage. Remove a download first.");
      const bytes = await response.arrayBuffer();
      const view = new DataView(bytes);
      if (
        bytes.byteLength !== size ||
        view.getUint32(0) !== 0x52494646 ||
        view.getUint32(8) !== 0x57415645 ||
        view.getUint32(4, true) + 8 !== size
      )
        throw new Error(
          "The download was incomplete or invalid. Please retry.",
        );
      // Save metadata needed for offline play before publishing the audio download.
      const original = await api.chapters(story.id);
      const chapterData = { chapters: original.chapters.map(sanitizeChapter) };
      const publicStory = sanitizeStory(story);
      const publicChapter = sanitizeChapter(chapter);
      const metadata = await caches.open(DATA_CACHE);
      await metadata.put(
        `/api/stories/${story.id}/chapters`,
        Response.json(chapterData),
      );
      await metadata.put(
        `/api/stories/${story.id}`,
        Response.json({ story: publicStory }),
      );
      const headers = new Headers(response.headers);
      headers.set(
        "X-SoundWave-Metadata",
        encodeURIComponent(
          JSON.stringify({
            story: publicStory,
            chapter: publicChapter,
            bytes: size,
            downloadedAt: new Date().toISOString(),
          }),
        ),
      );
      await (
        await caches.open(AUDIO_CACHE)
      ).put(chapter.audio_url, new Response(bytes, { status: 200, headers }));
      await refresh();
    } catch (err) {
      setError(
        err.name === "QuotaExceededError"
          ? "Browser storage is full. Remove a download and try again."
          : `Download failed: ${err.message}`,
      );
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(chapter.id);
        return next;
      });
    }
  };
  const remove = async (chapter) => {
    try {
      await (await caches.open(AUDIO_CACHE)).delete(chapter.audio_url);
      await refresh();
      setError("");
    } catch (err) {
      setError(`Could not remove download: ${err.message}`);
    }
  };
  const install = async () => {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } finally {
      setInstallPrompt(null);
    }
  };
  return (
    <OfflineContext.Provider
      value={{
        online,
        downloads,
        pending,
        error,
        ready,
        supported,
        download,
        remove,
        install,
        canInstall: Boolean(installPrompt),
        has: (id) => downloads.some((d) => d.chapter.id === id),
      }}
    >
      {children}
    </OfflineContext.Provider>
  );
}
