import { useState } from "react";
import { Link } from "react-router-dom";
import { usePlayer } from "./PlayerContext";

export function QueueActions({ story, chapter }) {
  const p = usePlayer(),
    [pending, setPending] = useState(false),
    [feedback, setFeedback] = useState("");
  async function add(next) {
    setPending(true);
    setFeedback("");
    try {
      if (await p.enqueue(story, chapter?.id, next))
        setFeedback(next ? "Playing next" : "Added to queue");
    } finally {
      setPending(false);
    }
  }
  const title = chapter?.title || `${story.title} chapters`;
  return (
    <div className="queue-actions">
      <button
        className="button secondary"
        disabled={pending || !p.queueReady}
        aria-label={`Play next: ${title}`}
        onClick={() => add(true)}
      >
        Play next
      </button>
      <button
        className="button secondary"
        disabled={pending || !p.queueReady}
        aria-label={`Add to queue: ${title}`}
        onClick={() => add(false)}
      >
        {pending ? "Adding…" : "Add to queue"}
      </button>
      {feedback && <span role="status">{feedback}</span>}
    </div>
  );
}
export default function QueuePanel() {
  const p = usePlayer(),
    [confirm, setConfirm] = useState(false);
  return (
    <section
      className="content-section queue-panel"
      aria-label="Playback queue"
    >
      <h1>Playback queue</h1>
      <p>
        This tab only · Up to 50 upcoming chapters · Repeated chapters play as
        separate entries.
      </p>
      {p.queueError && (
        <div role="alert">
          <p>{p.queueError}</p>
          <button className="button secondary" onClick={p.dismissQueueError}>
            Dismiss queue warning
          </button>
        </div>
      )}
      {p.queueMessage && <p role="status">{p.queueMessage}</p>}
      {!p.queueReady ? (
        <p role="status">Restoring your queue…</p>
      ) : (
        <>
          {p.queue.upcoming.length === 50 && (
            <p>
              Queue is full. Remove an upcoming chapter to add more or use
              Previous.
            </p>
          )}
          <h2>Current chapter</h2>
          {p.queue.current ? (
            <div className="queue-current">
              <strong>{p.queue.current.chapter.title}</strong>
              <span>{p.queue.current.story.title}</span>
              <span>{p.playing ? "Playing" : "Paused"}</span>
            </div>
          ) : (
            <p>No current chapter. Add chapters from a story or playlist.</p>
          )}
          <div className="queue-heading">
            <h2>Up next ({p.queue.upcoming.length})</h2>
            <button
              className="button secondary"
              onClick={() => p.move(1)}
              disabled={!p.hasNext}
            >
              {p.queue.current ? "Skip to next" : "Start queue"}
            </button>
          </div>
          {p.queue.upcoming.length ? (
            <>
              <ol className="queue-list">
                {p.queue.upcoming.map((entry, index) => (
                  <li key={entry.id}>
                    <div>
                      <strong>{entry.chapter.title}</strong>
                      <span>{entry.story.title}</span>
                    </div>
                    <div className="queue-actions">
                      <button
                        className="button secondary"
                        aria-label={`Move queue item ${index + 1} up`}
                        disabled={index === 0}
                        onClick={() =>
                          p.editQueue({ type: "move", id: entry.id, delta: -1 })
                        }
                      >
                        ↑ Up
                      </button>
                      <button
                        className="button secondary"
                        aria-label={`Move queue item ${index + 1} down`}
                        disabled={index === p.queue.upcoming.length - 1}
                        onClick={() =>
                          p.editQueue({ type: "move", id: entry.id, delta: 1 })
                        }
                      >
                        ↓ Down
                      </button>
                      <button
                        className="button secondary"
                        aria-label={`Remove queue item ${index + 1}: ${entry.chapter.title}`}
                        onClick={() =>
                          p.editQueue({ type: "remove", id: entry.id })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
              {confirm ? (
                <div role="group" aria-label="Confirm clearing upcoming queue">
                  <p>
                    Clear upcoming chapters? Current playback will continue.
                  </p>
                  <button
                    className="button secondary"
                    onClick={() => setConfirm(false)}
                  >
                    Keep queue
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => {
                      p.editQueue({ type: "clear" });
                      setConfirm(false);
                    }}
                  >
                    Confirm clear upcoming
                  </button>
                </div>
              ) : (
                <button
                  className="button secondary"
                  onClick={() => setConfirm(true)}
                >
                  Clear upcoming queue
                </button>
              )}
            </>
          ) : (
            <p>
              Nothing up next. Playback stops at the end of the current chapter.{" "}
              <Link to="/">Find a story</Link> or{" "}
              <Link to="/library">open a playlist</Link>.
            </p>
          )}
        </>
      )}
    </section>
  );
}
