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
    error.current = data?.current;
    error.chapter = data?.chapter;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}
export const api = {
  retryPrivateProcessing: (s, c, id, revision, signal, session = scope) =>
    request(
      `/creator/stories/${s}/chapters/${c}/media/${id}/processing/retry`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: revision }),
        signal,
      },
      session,
    ),
  privateMediaStatus: (s, c, signal, session = scope) =>
    request(`/creator/stories/${s}/chapters/${c}/media`, { signal }, session),
  privateAsset: (s, c, id, signal, session = scope) =>
    request(
      `/creator/stories/${s}/chapters/${c}/media/${id}`,
      { signal },
      session,
    ),
  reservePrivateMedia: (s, c, body, signal, session = scope) =>
    request(
      `/creator/stories/${s}/chapters/${c}/media`,
      { method: "POST", body: JSON.stringify(body), signal },
      session,
    ),
  removePrivateMedia: (s, c, id, revision, signal, session = scope) =>
    request(
      `/creator/stories/${s}/chapters/${c}/media/${id}`,
      {
        method: "DELETE",
        body: JSON.stringify({ expectedRevision: revision }),
        signal,
      },
      session,
    ),
  drafts: (params, signal, session = scope) =>
    request(`/creator/stories?${params}`, { signal }, session),
  draft: (id, signal, session = scope) =>
    request(`/creator/stories/${id}`, { signal }, session),
  createDraft: (body, signal, session = scope) =>
    request(
      "/creator/stories",
      { method: "POST", body: JSON.stringify(body), signal },
      session,
    ),
  saveDraft: (id, body, signal, session = scope) =>
    request(
      `/creator/stories/${id}`,
      { method: "PUT", body: JSON.stringify(body), signal },
      session,
    ),
  archiveDraft: (id, revision, signal, session = scope) =>
    request(
      `/creator/stories/${id}/archive`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: revision }),
        signal,
      },
      session,
    ),
  addDraftChapter: (id, body, signal, session = scope) =>
    request(
      `/creator/stories/${id}/chapters`,
      { method: "POST", body: JSON.stringify(body), signal },
      session,
    ),
  saveDraftChapter: (id, chapter, body, signal, session = scope) =>
    request(
      `/creator/stories/${id}/chapters/${chapter}`,
      { method: "PUT", body: JSON.stringify(body), signal },
      session,
    ),
  removeDraftChapter: (id, chapter, body, signal, session = scope) =>
    request(
      `/creator/stories/${id}/chapters/${chapter}`,
      { method: "DELETE", body: JSON.stringify(body), signal },
      session,
    ),
  reorderDraft: (id, chapterIds, revision, signal, session = scope) =>
    request(
      `/creator/stories/${id}/chapters/order`,
      {
        method: "PUT",
        body: JSON.stringify({ chapterIds, expectedRevision: revision }),
        signal,
      },
      session,
    ),
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

// XMLHttpRequest exposes actual transfer progress; no multipart parser or filenames.
export function uploadPrivateAudio(
  story,
  chapter,
  asset,
  file,
  { signal, session = scope, onProgress } = {},
) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const done = () => signal?.removeEventListener("abort", abort);
    xhr.open(
      "PUT",
      `/api/creator/stories/${story}/chapters/${chapter}/media/${asset}/bytes`,
    );
    xhr.setRequestHeader("Content-Type", "audio/wav");
    if (session?.csrfToken)
      xhr.setRequestHeader("X-CSRF-Token", session.csrfToken);
    if (session?.user?.id)
      xhr.setRequestHeader("X-Session-User", session.user.id);
    xhr.timeout = 125000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      done();
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
      else
        reject(
          Object.assign(
            Error(
              data?.error?.message || "Upload outcome unknown. Refresh status.",
            ),
            { status: xhr.status, code: data?.error?.code },
          ),
        );
    };
    xhr.onerror = xhr.ontimeout = () => {
      done();
      reject(Error("Upload outcome unknown. Refresh status."));
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    if (signal?.aborted)
      return reject(new DOMException("Request retired", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}
