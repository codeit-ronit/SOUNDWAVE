import { useEffect, useRef, useState } from "react";
import { api, uploadPrivateAudio } from "./api";
export default function DraftAudio({ storyId, chapter, scope, readOnly }) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState(null),
    [file, setFile] = useState(null),
    [asset, setAsset] = useState(null),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [unknown, setUnknown] = useState(false),
    [confirm, setConfirm] = useState(false);
  const live = useRef(true),
    controller = useRef(null),
    attempt = useRef(null),
    running = useRef(false),
    preview = useRef(null);
  const args = [storyId, chapter.id],
    pending =
      asset && ["reserved", "uploading", "quarantined"].includes(asset.status);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      controller.current?.abort();
      const a = preview.current;
      if (a) {
        a.pause();
        a.removeAttribute("src");
        a.load();
      }
    };
  }, []);
  async function load() {
    if (running.current) return;
    const c = new AbortController();
    controller.current?.abort();
    controller.current = c;
    setBusy(true);
    setError("");
    try {
      const d = await api.privateMediaStatus(...args, c.signal, scope);
      if (!live.current || c.signal.aborted) return;
      setData(d);
      if (asset) {
        const a = await api.privateAsset(...args, asset.id, c.signal, scope);
        if (!live.current || c.signal.aborted) return;
        setAsset(a.asset);
        if (
          !["reserved", "uploading", "quarantined"].includes(a.asset.status)
        ) {
          setUnknown(false);
          attempt.current = null;
        }
      } else
        setAsset(
          d.recent.find((a) =>
            ["reserved", "uploading", "quarantined"].includes(a.status),
          ) || null,
        );
    } catch (e) {
      if (live.current && !c.signal.aborted) setError(e.message);
    } finally {
      if (live.current && !c.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    if (open) void load();
  }, [open, chapter.revision]);
  async function upload() {
    if (running.current || !file || !data) return;
    running.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    setProgress(0);
    const c = new AbortController();
    controller.current?.abort();
    controller.current = c;
    let current = asset;
    try {
      if (!current || ["failed", "deleted"].includes(current.status)) {
        attempt.current ??= {
          requestId: crypto.randomUUID(),
          byteSize: file.size,
          expectedChapterRevision: chapter.revision,
          expectedHeadRevision: data.headRevision,
        };
        const result = await api.reservePrivateMedia(
          ...args,
          attempt.current,
          c.signal,
          scope,
        );
        if (!live.current || c.signal.aborted) return;
        current = result.asset;
        setAsset(current);
      }
      if (current.status === "validated") {
        setMessage("Private audio validated. Still unpublished.");
        setUnknown(false);
        attempt.current = null;
      } else if (current.status === "reserved") {
        const result = await uploadPrivateAudio(...args, current.id, file, {
          signal: c.signal,
          session: scope,
          onProgress: (n) => {
            if (live.current) setProgress(n);
          },
        });
        if (!live.current || c.signal.aborted) return;
        setAsset(result.asset);
        setMessage("Private audio validated. Still unpublished.");
        setUnknown(false);
        attempt.current = null;
      } else
        throw Error(
          "Upload is still processing or no longer reserved. Refresh status before retrying.",
        );
      const d = await api.privateMediaStatus(...args, c.signal, scope);
      if (live.current && !c.signal.aborted) setData(d);
    } catch (e) {
      if (live.current) {
        setError(
          c.signal.aborted
            ? "Upload cancelled. Refresh status to resolve any accepted bytes."
            : e.message,
        );
        setUnknown(true);
      }
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function remove(target = asset) {
    if (!target || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    const c = new AbortController();
    controller.current?.abort();
    controller.current = c;
    try {
      const latest = await api.privateAsset(
        ...args,
        target.id,
        c.signal,
        scope,
      );
      await api.removePrivateMedia(
        ...args,
        target.id,
        latest.asset.revision,
        c.signal,
        scope,
      );
      if (!live.current || c.signal.aborted) return;
      setAsset(null);
      attempt.current = null;
      setUnknown(false);
      setConfirm(false);
      setFile(null);
      setMessage("Private audio removed. Cleanup may finish asynchronously.");
      const d = await api.privateMediaStatus(...args, c.signal, scope);
      if (live.current && !c.signal.aborted) setData(d);
    } catch (e) {
      if (live.current && !c.signal.aborted) setError(e.message);
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  }
  const locked = busy || unknown || pending;
  return (
    <div className="studio-audio">
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide audio for" : "Manage audio for"} {chapter.title}
      </button>
      {open && (
        <section
          className="settings-card"
          aria-label={`Private audio for ${chapter.title}`}
        >
          <h3>Private chapter audio</h3>
          <p>
            PCM 16-bit WAV with a canonical 44-byte header only; metadata chunks
            are unsupported. Technical validation does not publish your content.
          </p>
          {busy && (
            <p role="status">
              {running.current
                ? "Uploading or validating…"
                : "Loading media status…"}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {message && <p role="status">{message}</p>}
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void load()}
          >
            Refresh media status
          </button>
          {data && (
            <>
              <p>
                Storage: {data.usedBytes} / {data.quotaBytes} bytes · Per file:{" "}
                {data.maxBytes} bytes
              </p>
              <p>
                Current audio: {data.current ? data.current.status : "none"}
              </p>
              {asset && (
                <p role="status">
                  Upload status: {asset.status}
                  {asset.errorCode ? ` · ${asset.errorCode}` : ""}
                  {asset.cleanupPending ? " · cleanup pending" : ""}
                </p>
              )}
              {unknown && (
                <p role="status">
                  Outcome needs checking. Refresh status; retrying a reservation
                  keeps its original request ID. Do not select a different file
                  until resolved.
                </p>
              )}
              {data.current?.status === "validated" &&
                data.canPreview !== false && (
                  <audio
                    ref={preview}
                    aria-label={`Private preview for ${chapter.title}`}
                    onKeyDown={(event) => event.stopPropagation()}
                    controls
                    preload="none"
                    src={`/api/creator/stories/${storyId}/chapters/${chapter.id}/media/${data.current.id}/preview`}
                  />
                )}
              {!readOnly && (
                <>
                  <label>
                    Audio file for {chapter.title}
                    <input
                      type="file"
                      accept=".wav,audio/wav,audio/x-wav"
                      disabled={locked}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        setError("");
                        setMessage("");
                        attempt.current = null;
                        setAsset(null);
                        if (
                          f &&
                          (!f.size ||
                            f.size > data.maxBytes ||
                            !/\.wav$/i.test(f.name) ||
                            (f.type &&
                              ![
                                "audio/wav",
                                "audio/x-wav",
                                "application/octet-stream",
                              ].includes(f.type)))
                        ) {
                          setFile(null);
                          setError(
                            "Select a nonempty WAV file within the displayed size limit. The server verifies actual bytes.",
                          );
                        } else setFile(f || null);
                      }}
                    />
                  </label>
                  <button
                    className="button primary"
                    disabled={
                      busy || !file || (pending && asset.status !== "reserved")
                    }
                    onClick={() => void upload()}
                  >
                    {unknown ? "Retry same upload" : "Upload private WAV"}
                  </button>
                  {busy && running.current && (
                    <button
                      className="button secondary"
                      onClick={() => controller.current?.abort()}
                    >
                      Cancel upload
                    </button>
                  )}
                  <progress
                    aria-label="Audio upload progress"
                    max="100"
                    value={progress}
                  />
                  <p>{progress}% transferred; validation must still finish.</p>
                  {(pending || data.current) && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setConfirm(true)}
                    >
                      {pending
                        ? "Cancel reserved upload"
                        : "Delete private audio"}
                    </button>
                  )}
                  {confirm && (
                    <div role="group" aria-label="Confirm audio removal">
                      <p>
                        Remove this private asset? Existing public audio and
                        playlists are unchanged.
                      </p>
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => setConfirm(false)}
                      >
                        Keep private audio
                      </button>
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          void remove(pending ? asset : data.current)
                        }
                      >
                        Confirm remove private audio
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
