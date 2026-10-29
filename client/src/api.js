let scope = null;
export function setSessionScope(value) {
  scope = value;
}
export async function request(path, options = {}, session = scope) {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(session?.csrfToken ? { "X-CSRF-Token": session.csrfToken } : {}),
      ...(session?.user?.id ? { "X-Session-User": session.user.id } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const error = new Error(
      data?.error?.message ||
        `Request failed (${response.status}). Please try again.`,
    );
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}
export const api = {
  analytics: (signal) => request("/analytics/overview", { signal }),
  analyticsEvent: (event, keepalive = false, session = scope) =>
    request(
      "/analytics/events",
      {
        method: "POST",
        body: JSON.stringify(event),
        keepalive,
      },
      session,
    ),
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
  save: (
    id,
    positionSeconds,
    completed = false,
    keepalive = false,
    version,
    session = scope,
  ) =>
    request(
      `/progress/${id}`,
      {
        method: "PUT",
        body: JSON.stringify({ positionSeconds, completed, ...version }),
        keepalive,
      },
      session,
    ),
};
