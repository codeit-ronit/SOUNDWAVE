import {
  Download,
  Trash2,
  Check,
  LoaderCircle,
  WifiOff,
  Play,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useOffline } from "./OfflineContext";
import { usePlayer } from "./PlayerContext";
import { Cover, Empty, SectionHeading } from "./components";
import { timeLabel } from "./playback";
export function ChapterDownload({ story, chapter }) {
  const offline = useOffline();
  const saved = offline.has(chapter.id);
  return (
    <button
      className={`download-button ${saved ? "downloaded" : ""}`}
      disabled={
        offline.pending.has(chapter.id) ||
        (!saved && (!offline.online || !offline.ready))
      }
      onClick={() =>
        saved ? offline.remove(chapter) : offline.download(story, chapter)
      }
      aria-label={`${saved ? "Remove download of" : "Download"} ${chapter.title}`}
      title={
        saved
          ? "Available offline · Click to remove"
          : !offline.ready
            ? "Offline setup is not ready yet"
            : "Download this chapter for offline listening"
      }
    >
      {offline.pending.has(chapter.id) ? (
        <LoaderCircle size={17} className="spin" />
      ) : saved ? (
        <Check size={17} />
      ) : (
        <Download size={17} />
      )}
      <span>{saved ? "Offline" : "Save offline"}</span>
    </button>
  );
}
export function PwaStatus() {
  const offline = useOffline();
  return (
    <>
      {!offline.online && (
        <div className="pwa-banner" role="status">
          <WifiOff size={16} />
          <span>
            You’re offline. Downloaded chapters can play; saving progress needs
            a connection.
          </span>
          <Link to="/downloads">Downloads</Link>
        </div>
      )}
      {offline.error && (
        <div className="pwa-banner pwa-error" role="alert">
          {offline.error}
        </div>
      )}
      {offline.canInstall && (
        <button className="install-button" onClick={offline.install}>
          <Download size={14} /> Install SoundWave
        </button>
      )}
    </>
  );
}
export function Downloads() {
  const offline = useOffline();
  const { playStory } = usePlayer();
  const bytes = offline.downloads.reduce((sum, d) => sum + d.bytes, 0);
  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">TAKE A STORY WITH YOU</span>
          <h1>
            Your downloads<span>.</span>
          </h1>
          <p>Only chapters you choose are stored on this device.</p>
        </div>
        <span className="originals-badge">
          {(bytes / 1024 / 1024).toFixed(1)} MB saved
        </span>
      </div>
      <section className="content-section">
        <SectionHeading
          title="Ready without a connection"
          eyebrow={`${offline.downloads.length} SAVED CHAPTERS`}
        />
        {!offline.supported ? (
          <Empty
            title="Offline storage unavailable"
            text="Use a supported browser on HTTPS or localhost to save chapters."
          />
        ) : !offline.downloads.length ? (
          <Empty
            title="A story for the road"
            text="Open a story and choose Save offline next to a chapter. Downloads use your browser’s storage on this device."
            library
          />
        ) : (
          <div className="download-list">
            {offline.downloads.map(({ story, chapter, bytes }) => (
              <article className="download-row" key={chapter.id}>
                <Cover story={story} mini className="continue-cover" />
                <div className="download-info">
                  <Link className="story-title" to={`/stories/${story.id}`}>
                    {story.title}
                  </Link>
                  <p>
                    {chapter.title} · {timeLabel(chapter.duration_seconds)}
                  </p>
                  <span>
                    <Check size={11} /> Available offline ·{" "}
                    {(bytes / 1024 / 1024).toFixed(1)} MB
                  </span>
                </div>
                <button
                  className="round-play"
                  aria-label={`Play downloaded ${chapter.title}`}
                  onClick={() => playStory(story, chapter.id)}
                >
                  <Play size={17} fill="currentColor" />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Remove download of ${chapter.title}`}
                  onClick={() => offline.remove(chapter)}
                >
                  <Trash2 size={17} />
                </button>
              </article>
            ))}
          </div>
        )}
        <p className="download-note">
          Downloads stay on this browser until removed or cleared by the
          browser. Progress and library changes require a connection.
          Undownloaded chapters are not available offline.
        </p>
        {!offline.ready && (
          <p className="download-note">
            Open the installed app or production version to save chapters.
            Installation requires HTTPS or localhost and a supported browser.
          </p>
        )}
      </section>
    </>
  );
}
