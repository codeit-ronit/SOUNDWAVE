export async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(
      data?.error?.message ||
        `Request failed (${response.status}). Please try again.`,
    );
  }
  return response.status === 204 ? null : response.json();
}
export const api = {
  analytics: (signal) => request("/analytics/overview", { signal }),
  analyticsEvent: (event, keepalive = false) =>
    request("/analytics/events", {
      method: "POST",
      body: JSON.stringify(event),
      keepalive,
    }),
  stories: (params, signal) =>
    request(`/stories?${new URLSearchParams(params)}`, { signal }),
  story: (id, signal) => request(`/stories/${id}`, { signal }),
  chapters: (id, signal) => request(`/stories/${id}/chapters`, { signal }),
  genres: (signal) => request("/genres", { signal }),
  progress: (signal) => request("/progress", { signal }),
  library: (signal) => request("/library", { signal }),
  recommendations: (signal) => request("/recommendations", { signal }),
  favorite: (id, favorite) =>
    request(`/library/${id}`, { method: favorite ? "PUT" : "DELETE" }),
  save: (id, positionSeconds, completed = false, keepalive = false, version) =>
    request(`/progress/${id}`, {
      method: "PUT",
      body: JSON.stringify({ positionSeconds, completed, ...version }),
      keepalive,
    }),
};
