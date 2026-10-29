import { Link } from "react-router-dom";
import {
  Activity,
  Radio,
  Orbit,
  Mail,
  TrainFront,
  Mountain,
  LibraryBig,
  Heart,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  LoaderCircle,
  AlertCircle,
  ArrowRight,
  Headphones,
} from "lucide-react";
import { usePlayer } from "./PlayerContext";
import { useLibrary } from "./LibraryContext";
import { timeLabel } from "./playback";
const symbols = {
  radio: Radio,
  orbit: Orbit,
  letters: Mail,
  train: TrainFront,
  mountain: Mountain,
  archive: LibraryBig,
};
export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="SoundWave home">
      <span className="brand-mark">
        <Activity size={25} />
      </span>
      Sound<span>Wave</span>
      <span className="brand-dot" />
    </Link>
  );
}
export function Cover({ story, className = "", mini = false }) {
  const Symbol = symbols[story.symbol] || Radio;
  return (
    <div
      className={`cover cover-${story.symbol} ${className}`}
      style={{ "--cover": story.color }}
      aria-hidden="true"
    >
      <div className="cover-grid" />
      <div className="cover-halo" />
      <div className="cover-ring orbit-one" />
      <div className="cover-ring orbit-two" />
      <div className="cover-emblem">
        <Symbol strokeWidth={0.8} />
      </div>
      {!mini && (
        <>
          <span className="cover-label">SOUNDWAVE ORIGINAL</span>
          <div className="cover-title">{story.title}</div>
          <span className="cover-bottom">
            AN AUDIO EXPERIENCE <span>✦</span>
          </span>
        </>
      )}
    </div>
  );
}
export function FavoriteButton({ story, label = false }) {
  const library = useLibrary();
  const favorite = library.has(story.id);
  return (
    <button
      disabled={library.loading || library.pending.has(story.id)}
      className={`${label ? "button secondary" : "icon-button favorite"} ${favorite ? "is-favorite" : ""}`}
      onClick={() => library.toggle(story)}
      aria-label={`${favorite ? "Remove" : "Add"} ${story.title} ${favorite ? "from" : "to"} your library`}
      aria-pressed={favorite}
    >
      {library.pending.has(story.id) ? (
        <LoaderCircle className="spin" size={18} />
      ) : (
        <Heart size={18} fill={favorite ? "currentColor" : "none"} />
      )}{" "}
      {label && (favorite ? "In your library" : "Add to library")}
    </button>
  );
}
export function StoryCard({ story, index, reason }) {
  const { playStory } = usePlayer();
  return (
    <article className="story-card">
      <div className="card-art">
        <Link to={`/stories/${story.id}`} aria-label={`Open ${story.title}`}>
          <Cover story={story} />
        </Link>
        <FavoriteButton story={story} />
        <button
          className="card-play"
          aria-label={`Play ${story.title}`}
          onClick={() => playStory(story)}
        >
          <Play size={20} fill="currentColor" />
        </button>
        {index !== undefined && (
          <span className="card-rank">
            {String(index + 1).padStart(2, "0")}
          </span>
        )}
      </div>
      <div className="card-meta">
        <span className="genre-dot" style={{ background: story.color }} />
        {story.genre}
        <span>•</span>
        {story.chapter_count} chapters
      </div>
      <Link to={`/stories/${story.id}`} className="story-title">
        {story.title}
      </Link>
      <p className="card-subtitle">{reason || story.tagline}</p>
    </article>
  );
}
export function SectionHeading({ eyebrow, title, aside }) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      {aside}
    </div>
  );
}
export function Loading({ label = "Finding your next story…" }) {
  return (
    <div className="state" role="status">
      <LoaderCircle className="spin" size={25} />
      <p>{label}</p>
    </div>
  );
}
export function ErrorState({ message, retry }) {
  return (
    <div className="state error-state" role="alert">
      <AlertCircle size={25} />
      <p>{message}</p>
      {retry && (
        <button className="button secondary" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
export function Empty({ title, text, library = false }) {
  return (
    <div className="state empty">
      <span className="empty-icon">
        {library ? <LibraryBig /> : <Headphones />}
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {library && (
        <Link className="button primary" to="/">
          Explore stories <ArrowRight size={16} />
        </Link>
      )}
    </div>
  );
}
export function Player() {
  const p = usePlayer();
  return (
    <div className={`player-shell ${p.active ? "" : "player-idle"}`}>
      {(p.error || p.saveError) && (
        <div className="player-notice" role="alert">
          <AlertCircle size={15} />
          <span>{p.error || p.saveError}</span>
          <button onClick={p.error ? p.retry : p.retrySave}>Retry</button>
        </div>
      )}
      <div className="player">
        <div className="now-playing">
          {p.active ? (
            <>
              <Link to={`/stories/${p.active.story.id}`}>
                <Cover story={p.active.story} mini className="player-cover" />
              </Link>
              <div>
                <Link
                  to={`/stories/${p.active.story.id}`}
                  className="now-title"
                >
                  {p.active.story.title}
                </Link>
                <p>
                  Ch. {p.active.chapter.chapter_number} ·{" "}
                  {p.active.chapter.title}
                </p>
              </div>
              <FavoriteButton story={p.active.story} />
            </>
          ) : (
            <>
              <span className="idle-headphones">
                <Headphones size={24} />
              </span>
              <div>
                <strong>Your next chapter awaits</strong>
                <p>Choose a story and press play</p>
              </div>
            </>
          )}
        </div>
        <div className="playback-controls">
          <div className="transport">
            <button
              className="icon-button"
              aria-label="Previous chapter"
              onClick={() => p.move(-1)}
              disabled={!p.hasPrevious}
            >
              <SkipBack size={18} fill="currentColor" />
            </button>
            <button
              className="icon-button skip-seconds"
              aria-label="Back 10 seconds"
              onClick={() => p.seek(p.position - 10)}
              disabled={!p.active}
            >
              <RotateCcw size={21} />
              <span>10</span>
            </button>
            <button
              className="main-play"
              onClick={p.toggle}
              disabled={!p.active}
              aria-label={p.playing ? "Pause" : "Play"}
            >
              {p.loading ? (
                <LoaderCircle className="spin" size={21} />
              ) : p.playing ? (
                <Pause fill="currentColor" size={20} />
              ) : (
                <Play fill="currentColor" size={20} />
              )}
            </button>
            <button
              className="icon-button skip-seconds"
              aria-label="Forward 10 seconds"
              onClick={() => p.seek(p.position + 10)}
              disabled={!p.active}
            >
              <RotateCw size={21} />
              <span>10</span>
            </button>
            <button
              className="icon-button"
              aria-label="Next chapter"
              onClick={() => p.move(1)}
              disabled={!p.hasNext}
            >
              <SkipForward size={18} fill="currentColor" />
            </button>
          </div>
          <div className="seek-row">
            <span>{timeLabel(p.position)}</span>
            <input
              aria-label="Playback position"
              type="range"
              min="0"
              max={p.duration || 1}
              step="0.1"
              value={Math.min(p.position, p.duration || 1)}
              disabled={!p.active}
              onChange={(e) => p.seek(Number(e.target.value))}
              style={{
                "--fill": `${p.duration ? (p.position / p.duration) * 100 : 0}%`,
              }}
            />
            <span>{timeLabel(p.duration)}</span>
          </div>
        </div>
        <div className="player-extra">
          <span className="saved-label">
            <span className="live-dot" />
            {p.saveError ? "Save failed" : "Progress autosaves"}
          </span>
          <div className="volume">
            <button
              className="icon-button"
              aria-label={p.volume ? "Mute audio" : "Unmute audio"}
              onClick={() => p.setVolume(p.volume ? 0 : 0.8)}
            >
              {p.volume ? <Volume2 size={19} /> : <VolumeX size={19} />}
            </button>
            <input
              aria-label="Volume"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={p.volume}
              onChange={(e) => p.setVolume(Number(e.target.value))}
              style={{ "--fill": `${p.volume * 100}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
