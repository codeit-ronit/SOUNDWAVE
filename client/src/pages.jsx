import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  Play,
  Headphones,
  Clock3,
  Check,
  Radio,
  Sparkles,
  ChevronLeft,
  ListMusic,
  Search,
  X,
} from "lucide-react";
import { ChapterDownload } from "./Downloads";
import { api } from "./api";
import { useResource } from "./useResource";
import { usePlayer } from "./PlayerContext";
import { useLibrary } from "./LibraryContext";
import {
  Cover,
  StoryCard,
  FavoriteButton,
  SectionHeading,
  Loading,
  ErrorState,
  Empty,
} from "./components";
import { timeLabel } from "./playback";

function ContinueListening({ stories }) {
  const { playStory } = usePlayer();
  if (!stories.length) return null;
  return (
    <section className="content-section continue-section">
      <SectionHeading
        eyebrow="RIGHT WHERE YOU LEFT OFF"
        title="Continue listening"
      />
      <div className="continue-grid">
        {stories.map((story) => (
          <article className="continue-card" key={story.id}>
            <Link to={`/stories/${story.id}`}>
              <Cover story={story} mini className="continue-cover" />
            </Link>
            <div className="continue-info">
              <Link className="story-title" to={`/stories/${story.id}`}>
                {story.title}
              </Link>
              <p>
                Chapter {story.chapter_number} · {story.chapter_title}
              </p>
              <div className="mini-track">
                <span
                  style={{
                    width: `${(story.position_seconds / story.chapter_duration_seconds) * 100}%`,
                  }}
                />
              </div>
              <span className="tiny">
                {timeLabel(story.position_seconds)} of{" "}
                {timeLabel(story.chapter_duration_seconds)}
              </span>
            </div>
            <button
              className="round-play"
              aria-label={`Resume ${story.title}`}
              data-player-shortcuts
              onClick={() => playStory(story, story.resume_chapter_id)}
            >
              <Play size={18} fill="currentColor" />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

export function Discover() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "",
    genre = params.get("genre") || "",
    sort = params.get("sort") || "trending";
  const { playStory, revision } = usePlayer();
  const listing = useResource(
    (signal) => api.stories({ q, genre, sort }, signal),
    [q, genre, sort],
  );
  const genres = useResource(api.genres, []);
  const history = useResource(api.progress, [revision]);
  const recommendations = useResource(api.recommendations, [revision]);
  const featured = useResource(
    (signal) => api.stories({ sort: "trending" }, signal),
    [],
  );
  const hero = featured.data?.stories[0];
  const filtered = Boolean(q || genre);
  const update = (key, value) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace: true });
  };
  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">A LITTLE ESCAPE. A GREAT STORY.</span>
          <h1>
            Find your next obsession<span>.</span>
          </h1>
          <p>Extraordinary worlds. Unforgettable voices. Just press play.</p>
        </div>
        <span className="originals-badge">
          <Headphones size={15} /> Original audio stories
        </span>
      </div>
      {!filtered && hero && (
        <section className="hero">
          <div className="hero-content">
            <span className="feature-label">
              <span className="live-dot" /> THE SPOTLIGHT <span>01 / 06</span>
            </span>
            <div className="hero-tags">
              <span>{hero.genre}</span>
              <span>SoundWave Original</span>
            </div>
            <h2>{hero.title}</h2>
            <p>{hero.description}</p>
            <div className="hero-facts">
              <span>
                <Headphones size={14} />
                {hero.chapter_count} chapters
              </span>
              <span>
                <Clock3 size={14} />
                {timeLabel(hero.duration_seconds)} total
              </span>
              <span>Original narration</span>
            </div>
            <div className="hero-actions">
              <button
                className="button primary"
                data-player-shortcuts
                onClick={() => playStory(hero)}
              >
                <Play size={17} fill="currentColor" /> Start listening
              </button>
              <Link className="button ghost" to={`/stories/${hero.id}`}>
                View story <ArrowUpRight size={17} />
              </Link>
            </div>
          </div>
          <div className="hero-visual">
            <div className="hero-glow" />
            <div className="hero-record">
              <div className="record-center">
                <Radio size={52} strokeWidth={1} />
                <span>
                  THE MIDNIGHT
                  <br />
                  FREQUENCY
                </span>
                <small>SOUNDWAVE · ORIGINALS</small>
              </div>
            </div>
            <span className="hero-visual-note">
              TUNE OUT THE WORLD.
              <br />
              TUNE INTO A STORY.
            </span>
            <span className="hero-spark spark-one">✦</span>
            <span className="hero-spark spark-two">+</span>
          </div>
        </section>
      )}
      {!filtered && (
        <>
          {history.error ? (
            <ErrorState
              message={`Listening history: ${history.error}`}
              retry={history.retry}
            />
          ) : (
            history.data && (
              <ContinueListening stories={history.data.continueListening} />
            )
          )}
          {!history.loading &&
            !history.error &&
            !history.data?.continueListening.length && (
              <div className="first-listen">
                <span className="first-listen-icon">
                  <Headphones size={22} />
                </span>
                <div>
                  <strong>Make yourself at home.</strong>
                  <p>
                    Your listening progress is saved automatically. Start a
                    story to pick up here later.
                  </p>
                </div>
                <span className="demo-tag">DEMO LISTENER</span>
              </div>
            )}
        </>
      )}
      <section className="content-section" id="browse">
        <SectionHeading
          eyebrow="YOUR NEXT GREAT LISTEN"
          title={
            q
              ? `Results for “${q}”`
              : genre
                ? `${genre} stories`
                : "Explore the collection"
          }
          aside={
            <span className="collection-count">
              {listing.data?.total ?? "—"} stories <ArrowRight size={15} />
            </span>
          }
        />
        <div className="discovery-controls">
          <div className="genre-filters" aria-label="Filter by genre">
            <button
              onClick={() => update("genre", "")}
              className={!genre ? "selected" : ""}
            >
              All stories
            </button>
            {genres.data?.genres.map((g) => (
              <button
                key={g}
                className={genre === g ? "selected" : ""}
                onClick={() => update("genre", g)}
              >
                {g}
              </button>
            ))}
            {genres.error && (
              <button onClick={genres.retry}>Retry genres</button>
            )}
          </div>
          <label className="sort-control">
            Sort by{" "}
            <select
              aria-label="Sort stories"
              value={sort}
              onChange={(e) => update("sort", e.target.value)}
            >
              <option value="trending">Trending</option>
              <option value="title">Title A–Z</option>
              <option value="newest">Newest</option>
            </select>
          </label>
        </div>
        {q && (
          <div className="search-summary">
            <Search size={15} />
            <span>Searching titles and genres</span>
            <button onClick={() => update("q", "")}>
              Clear search <X size={13} />
            </button>
          </div>
        )}
        {listing.loading ? (
          <Loading />
        ) : listing.error ? (
          <ErrorState message={listing.error} retry={listing.retry} />
        ) : !listing.data?.stories.length ? (
          <Empty
            title="No stories found"
            text="Try a different title or genre, or clear your filters."
          />
        ) : (
          <div className="story-grid">
            {listing.data.stories.map((story, index) => (
              <StoryCard
                key={story.id}
                story={story}
                index={sort === "trending" ? index : undefined}
              />
            ))}
          </div>
        )}
      </section>
      {!filtered && (
        <section className="content-section recommended">
          <SectionHeading
            eyebrow="A LITTLE MORE YOU"
            title="Made for your ears"
            aside={
              <span className="recommendation-label">
                <Sparkles size={14} /> Rule-based picks
              </span>
            }
          />
          <p className="section-description">
            Picks inspired by your saved genres and listening history. New here?
            Start with our most popular stories.
          </p>
          {recommendations.error ? (
            <ErrorState
              message={recommendations.error}
              retry={recommendations.retry}
            />
          ) : recommendations.loading && !recommendations.data ? (
            <Loading />
          ) : recommendations.data?.stories.length ? (
            <div className="story-grid recommendations-grid">
              {recommendations.data.stories.map((story) => (
                <StoryCard
                  key={story.id}
                  story={story}
                  reason={story.recommendation_reason}
                />
              ))}
            </div>
          ) : (
            <Empty
              title="You’re all caught up"
              text="You’ve saved or finished every story in this demo collection."
            />
          )}
        </section>
      )}
    </>
  );
}

export function MyLibrary() {
  const library = useLibrary();
  const { revision } = usePlayer();
  const history = useResource(api.progress, [revision]);
  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow">YOUR STORIES, ALL TOGETHER</span>
          <h1>
            My library<span>.</span>
          </h1>
          <p>The worlds you want to return to. Saved for your next escape.</p>
        </div>
        <span className="originals-badge">
          {library.stories.length} saved{" "}
          {library.stories.length === 1 ? "story" : "stories"}
        </span>
      </div>
      {history.error ? (
        <ErrorState message={history.error} retry={history.retry} />
      ) : (
        history.data && (
          <ContinueListening stories={history.data.continueListening} />
        )
      )}
      <section className="content-section">
        <SectionHeading title="Your saved stories" eyebrow="THE GOOD STUFF" />
        {library.loading ? (
          <Loading label="Opening your library…" />
        ) : library.error ? (
          <ErrorState message={library.error} retry={library.refresh} />
        ) : !library.stories.length ? (
          <Empty
            title="Your library starts with a story"
            text="Tap the heart on any story to keep it here. Your favorites also help shape your recommendations."
            library
          />
        ) : (
          <div className="story-grid">
            {library.stories.map((story) => (
              <StoryCard key={story.id} story={story} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

export function StoryDetails() {
  const { id } = useParams();
  const { playStory, active, playing, toggle, revision } = usePlayer();
  const storyData = useResource((signal) => api.story(id, signal), [id]);
  const chaptersData = useResource(
    (signal) => api.chapters(id, signal),
    [id, revision],
  );
  if (storyData.loading) return <Loading label="Opening the story…" />;
  if (storyData.error)
    return <ErrorState message={storyData.error} retry={storyData.retry} />;
  const story = storyData.data.story;
  const chapters = chaptersData.data?.chapters || [];
  return (
    <>
      <Link className="back-link" to="/">
        <ChevronLeft size={17} /> Back to discover
      </Link>
      <section className="detail-hero" key={story.id}>
        <Cover story={story} className="detail-cover" />
        <div className="detail-content">
          <span className="eyebrow">SOUNDWAVE ORIGINAL</span>
          <span className="detail-genre" style={{ color: story.color }}>
            {story.genre}
          </span>
          <h1>{story.title}</h1>
          <p className="detail-tagline">{story.tagline}</p>
          <p className="detail-description">{story.description}</p>
          <div className="hero-facts">
            <span>
              <Headphones size={15} />
              {story.chapter_count} chapters
            </span>
            <span>
              <Clock3 size={15} />
              {timeLabel(story.duration_seconds)} total
            </span>
          </div>
          <div className="detail-actions">
            <button
              className="button primary"
              data-player-shortcuts
              onClick={() => playStory(story)}
            >
              <Play size={17} fill="currentColor" />
              {chapters.some((c) => c.position_seconds > 0 && !c.completed)
                ? "Resume story"
                : chapters.length && chapters.every((c) => c.completed)
                  ? "Listen again"
                  : "Start listening"}
            </button>
            <FavoriteButton story={story} label />
          </div>
          <span className="original-note">
            Original short fiction · Synthesized narration · Demo collection
          </span>
        </div>
      </section>
      <section className="content-section chapter-section">
        <SectionHeading
          title="The chapters"
          eyebrow="ONE MORE CHAPTER"
          aside={
            <span className="collection-count">
              <ListMusic size={17} />
              {story.chapter_count} chapters
            </span>
          }
        />
        {chaptersData.error ? (
          <ErrorState message={chaptersData.error} retry={chaptersData.retry} />
        ) : chaptersData.loading && !chapters.length ? (
          <Loading label="Loading chapters…" />
        ) : (
          <div className="chapter-list">
            {chapters.map((chapter) => {
              const isActive = active?.chapter.id === chapter.id;
              return (
                <div
                  key={chapter.id}
                  className={`chapter-row ${isActive ? "active" : ""}`}
                >
                  <span className="chapter-number">
                    {isActive && playing ? (
                      <span className="equalizer">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : (
                      String(chapter.chapter_number).padStart(2, "0")
                    )}
                  </span>
                  <div className="chapter-name">
                    <strong>{chapter.title}</strong>
                    <span>
                      {chapter.completed ? (
                        <>
                          <Check size={12} /> Completed
                        </>
                      ) : chapter.position_seconds > 0 ? (
                        `${timeLabel(chapter.position_seconds)} listened`
                      ) : (
                        `Chapter ${chapter.chapter_number} · Original narration`
                      )}
                    </span>
                  </div>
                  <ChapterDownload story={story} chapter={chapter} />
                  <span className="chapter-duration">
                    {timeLabel(chapter.duration_seconds)}
                  </span>
                  <button
                    className="round-play"
                    aria-label={`${isActive && playing ? "Pause" : "Play"} ${chapter.title}`}
                    data-player-shortcuts
                    onClick={() =>
                      isActive ? toggle() : playStory(story, chapter.id)
                    }
                  >
                    {isActive && playing ? (
                      <span className="pause-bars">Ⅱ</span>
                    ) : (
                      <Play size={17} fill="currentColor" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <div className="story-endnote">
        <Radio size={22} />
        <div>
          <strong>Small stories. A whole other world.</strong>
          <p>
            These short original chapters are created for the SoundWave demo.
            Listen, explore, and make them yours.
          </p>
        </div>
      </div>
    </>
  );
}
export function NotFound() {
  return (
    <Empty
      title="This page wandered off"
      text="Find your way back to a great story."
      library
    />
  );
}
