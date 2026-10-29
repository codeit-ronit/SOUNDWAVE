import { Clock3, CheckCircle2, Heart, Activity, BarChart3 } from "lucide-react";
import { api } from "./api";
import { usePlayer } from "./PlayerContext";
import { useResource } from "./useResource";
import { Loading, ErrorState, SectionHeading } from "./components";
const eventLabels = {
  playback_started: "Started listening",
  playback_paused: "Paused",
  chapter_completed: "Chapter completed",
  story_favorited: "Saved to library",
  listening_interval: "Listening interval recorded",
};
function minutes(seconds) {
  return seconds < 60
    ? `${Math.round(seconds)} sec`
    : `${(seconds / 60).toFixed(1)} min`;
}
export default function Analytics() {
  const { revision } = usePlayer();
  const resource = useResource(api.analytics, [revision]);
  if (resource.loading && !resource.data)
    return <Loading label="Gathering your listening insights…" />;
  if (resource.error)
    return <ErrorState message={resource.error} retry={resource.retry} />;
  const data = resource.data;
  const dailyMax = Math.max(
    1,
    ...data.dailyActivity.map((d) => d.listeningSeconds),
  );
  const genreMax = Math.max(1, ...data.genres.map((g) => g.listeningSeconds));
  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">THE STORIES BEHIND YOUR LISTENING</span>
          <h1>
            Your listening insights<span>.</span>
          </h1>
          <p>Your listening habits, one chapter at a time.</p>
        </div>
        <button className="button secondary" onClick={resource.retry}>
          Refresh insights
        </button>
      </div>
      <div className="metric-grid">
        {[
          {
            label: "Recorded listening",
            value: minutes(data.totalListeningSeconds),
            icon: Clock3,
          },
          {
            label: "Completed chapters",
            value: data.completedChapters,
            icon: CheckCircle2,
          },
          {
            label: "Favorite stories",
            value: data.favoriteStories,
            icon: Heart,
          },
        ].map(({ label, value, icon: Icon }) => (
          <div className="metric-card" key={label}>
            <Icon size={21} />
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="insight-grid">
        <section className="insight-panel">
          <SectionHeading eyebrow="LAST 7 DAYS · UTC" title="Time well spent" />
          <div
            className="activity-bars"
            role="img"
            aria-label={data.dailyActivity
              .map((day) => `${day.date}: ${minutes(day.listeningSeconds)}`)
              .join(", ")}
          >
            {data.dailyActivity.map((day) => (
              <div className="activity-day" key={day.date}>
                <span className="day-value">
                  {minutes(day.listeningSeconds)}
                </span>
                <div className="day-track">
                  <span
                    style={{
                      height: `${(day.listeningSeconds / dailyMax) * 100}%`,
                    }}
                  />
                </div>
                <span>
                  {new Date(`${day.date}T12:00:00Z`).toLocaleDateString(
                    undefined,
                    { weekday: "short", timeZone: "UTC" },
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className="insight-panel">
          <SectionHeading
            eyebrow="WHERE YOU GET LOST"
            title="Your favorite worlds"
          />
          {data.genres.length ? (
            <div className="genre-bars">
              {data.genres.map((genre, index) => (
                <div key={genre.genre}>
                  <div className="genre-bar-label">
                    <span>{genre.genre}</span>
                    <span>{minutes(genre.listeningSeconds)}</span>
                  </div>
                  <div className="genre-track">
                    <span
                      style={{
                        width: `${(genre.listeningSeconds / genreMax) * 100}%`,
                        opacity: 1 - index * 0.1,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="analytics-empty">
              <BarChart3 />
              <p>Listen to a chapter to see your genre activity.</p>
            </div>
          )}
        </section>
      </div>
      <section className="content-section">
        <SectionHeading
          eyebrow="YOUR LISTENING JOURNAL"
          title="Recent activity"
        />
        {data.recentActivity.length ? (
          <div className="activity-list">
            {data.recentActivity.map((event) => (
              <div className="activity-row" key={event.event_id}>
                <span className="activity-symbol">
                  <Activity size={16} />
                </span>
                <div>
                  <strong>{eventLabels[event.event_type]}</strong>
                  <p>
                    {event.story_title}
                    {event.chapter_title ? ` · ${event.chapter_title}` : ""}
                  </p>
                </div>
                <time dateTime={event.created_at}>
                  {new Date(event.created_at).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
            ))}
          </div>
        ) : (
          <div className="analytics-empty">
            <Activity />
            <p>Your next listen starts your activity journal.</p>
          </div>
        )}
      </section>
      <p className="download-note">
        Listening time counts the time you spend playing stories, with pauses,
        buffering and skipped sections excluded. Playback speed does not change
        this measure. Offline activity may be missing from these totals. Your
        completed chapters and saved stories reflect this demo listener’s
        history.
      </p>
    </>
  );
}
