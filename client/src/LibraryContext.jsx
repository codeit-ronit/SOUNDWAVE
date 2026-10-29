import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";
import { api } from "./api";
import { usePlayer } from "./PlayerContext";
const LibraryContext = createContext(null);
export const useLibrary = () => useContext(LibraryContext);
export function LibraryProvider({ children }) {
  const [stories, setStories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(new Set());
  const { notify } = usePlayer();
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.library();
      setStories(data.stories);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const toggle = async (story) => {
    if (pending.has(story.id)) return;
    setPending((p) => new Set(p).add(story.id));
    const exists = stories.some((s) => s.id === story.id);
    try {
      await api.favorite(story.id, !exists);
      setStories((rows) =>
        exists
          ? rows.filter((s) => s.id !== story.id)
          : [{ ...story, is_favorite: true }, ...rows],
      );
      setError("");
      notify();
    } catch (err) {
      setError(`Could not update your library: ${err.message}`);
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(story.id);
        return next;
      });
    }
  };
  return (
    <LibraryContext.Provider
      value={{
        stories,
        loading,
        error,
        pending,
        toggle,
        refresh,
        has: (id) => stories.some((s) => s.id === id),
      }}
    >
      {children}
    </LibraryContext.Provider>
  );
}
