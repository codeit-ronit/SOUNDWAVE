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
    error.code = data?.error?.code;
    error.progress = data?.progress;
    error.historyRevision = data?.historyRevision;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}
export const api = {
  creator: (signal, session = scope) =>
    request("/creator", { signal }, session),
  saveCreator: (action, profile, signal, session = scope) =>
    request(
      "/creator",
      {
        method: action === "activate" ? "POST" : "PUT",
        body: JSON.stringify(profile),
        signal,
      },
      session,
    ),
  deactivateCreator: (signal, session = scope) =>
    request(
      "/creator/deactivate",
      { method: "POST", body: "{}", signal },
      session,
    ),
  history: (params, signal, session = scope) =>
    request(`/history?${params}`, { signal }, session),
  removeHistory: (id, expectedRevision, signal, session = scope) =>
    request(
      `/history/${id}`,
      { method: "DELETE", body: JSON.stringify({ expectedRevision }), signal },
      session,
    ),
  clearHistory: (expectedHistoryRevision, signal, session = scope) =>
    request(
      "/history",
      {
        method: "DELETE",
        body: JSON.stringify({
          expectedHistoryRevision,
          confirm: "CLEAR_SAVED_HISTORY",
        }),
        signal,
      },
      session,
    ),
  profile: (signal, session = scope) =>
    request("/profile", { signal }, session),
  saveProfile: (displayName, session = scope) =>
    request(
      "/profile",
      { method: "PUT", body: JSON.stringify({ displayName }) },
      session,
    ),
  settings: (signal, session = scope) =>
    request("/settings", { signal }, session),
  saveSettings: (patch, session = scope) =>
    request(
      "/settings",
      { method: "PUT", body: JSON.stringify(patch) },
      session,
    ),
  playlists: (params, signal, session = scope) =>
    request(`/playlists?${new URLSearchParams(params)}`, { signal }, session),
  playlist: (id, signal, session = scope) =>
    request(`/playlists/${id}`, { signal }, session),
  createPlaylist: (name, session = scope) =>
    request(
      "/playlists",
      { method: "POST", body: JSON.stringify({ name }) },
      session,
    ),
  renamePlaylist: (id, name, session = scope) =>
    request(
      `/playlists/${id}`,
      { method: "PUT", body: JSON.stringify({ name }) },
      session,
    ),
  deletePlaylist: (id, session = scope) =>
    request(`/playlists/${id}`, { method: "DELETE" }, session),
  addPlaylistStory: (id, story, session = scope) =>
    request(`/playlists/${id}/stories/${story}`, { method: "PUT" }, session),
  removePlaylistStory: (id, story, session = scope) =>
    request(`/playlists/${id}/stories/${story}`, { method: "DELETE" }, session),
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
  story: (id, signal, session = scope) =>
    request(`/stories/${id}`, { signal }, session),
  chapters: (id, signal, session = scope) =>
    request(`/stories/${id}/chapters`, { signal }, session),
  genres: (signal) => request("/genres", { signal }),
  progress: (signal) => request("/progress", { signal }),
  progressChapter: (id, signal, session = scope) =>
    request(`/progress/${id}`, { signal }, session),
  library: (signal) => request("/library", { signal }),
  recommendations: (signal) => request("/recommendations", { signal }),
  favorite: (id, favorite) =>
    request(`/library/${id}`, { method: favorite ? "PUT" : "DELETE" }),
  save: async (
    id,
    positionSeconds,
    completed = false,
    keepalive = false,
    version,
    session = scope,
  ) => {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 8000);
    try {
      return await request(
        `/progress/${id}`,
        {
          method: "PUT",
          body: JSON.stringify({ positionSeconds, completed, ...version }),
          keepalive,
          signal: controller.signal,
        },
        session,
      );
    } finally {
      clearTimeout(timer);
    }
  },
};
