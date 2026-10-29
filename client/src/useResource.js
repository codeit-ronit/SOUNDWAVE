import { useEffect, useState } from "react";
export function useResource(fetcher, dependencies) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetcher(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // Callers supply the stable request inputs as dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, retry]);
  return { data, error, loading, retry: () => setRetry((n) => n + 1) };
}
