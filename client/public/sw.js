/* Shell list is replaced by the Vite build. No audio is precached. */
const SHELL_FILES = /* PRECACHE */ [];
const SHELL = "soundwave-shell-BUILD_HASH";
const DATA = "soundwave-data-v2";
const AUDIO = "soundwave-audio-v1";
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("soundwave-") &&
                ![SHELL, DATA, AUDIO].includes(key),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
function rangeBounds(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : null;
  const end = match[2] ? Number(match[2]) : null;
  if (
    (start !== null && !Number.isSafeInteger(start)) ||
    (end !== null && !Number.isSafeInteger(end))
  )
    return null;
  if (start === null)
    return end > 0 ? [Math.max(0, size - end), size - 1] : null;
  if (start >= size || (end !== null && end < start)) return null;
  return [start, Math.min(end ?? size - 1, size - 1)];
}
async function audioResponse(request) {
  const audioCache = await caches.open(AUDIO).catch(() => null);
  const cached = audioCache && (await audioCache.match(request.url));
  if (!cached) return fetch(request);
  const range = request.headers.get("Range");
  if (!range) return cached;
  const bytes = await cached.arrayBuffer();
  const bounds = rangeBounds(range, bytes.byteLength);
  if (!bounds)
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${bytes.byteLength}`,
        "Content-Length": "0",
        "Accept-Ranges": "bytes",
      },
    });
  const [start, end] = bounds;
  return new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": "audio/wav",
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`,
    },
  });
}
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== "GET") return;
  if (/^\/api\/chapters\/\d+\/stream$/.test(url.pathname)) {
    event.respondWith(
      audioResponse(request).catch(
        () =>
          new Response("This chapter is not downloaded. Connect to listen.", {
            status: 503,
          }),
      ),
    );
  } else if (url.pathname.startsWith("/api/auth/")) {
    // Session identities and CSRF tokens are never cached or served offline.
    return;
  } else if (url.pathname.startsWith("/api/")) {
    // Only successful JSON reads are cached. Mutations and partial audio are never cached here.
    event.respondWith(
      (async () => {
        const cache = await caches.open(DATA).catch(() => null);
        try {
          const response = await fetch(request);
          // Personal JSON is intentionally not persisted. Only sanitized public
          // chapter metadata is written explicitly by the download flow.

          return response;
        } catch {
          return (
            (cache && (await cache.match(request))) ||
            new Response(
              JSON.stringify({
                error: {
                  message:
                    "This information is unavailable offline. Open Downloads for saved chapters.",
                },
              }),
              { status: 503, headers: { "Content-Type": "application/json" } },
            )
          );
        }
      })(),
    );
  } else if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        async () =>
          (await caches.match("/index.html")) ||
          (await caches.match("/offline.html")),
      ),
    );
  } else if (SHELL_FILES.includes(url.pathname)) {
    event.respondWith(
      caches
        .match(request, { ignoreVary: true })
        .then((cached) => cached || fetch(request)),
    );
  }
});
