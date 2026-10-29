export function analyticsRepository(db) {
  return {
    event: (user, id) =>
      db
        .prepare(
          "SELECT * FROM listening_events WHERE user_id=? AND event_id=?",
        )
        .get(user, id),
    total: async (user) =>
      (
        await db
          .prepare(
            "SELECT COALESCE(SUM(listening_seconds),0) AS seconds FROM listening_events WHERE user_id=?",
          )
          .get(user)
      ).seconds,
    completed: async (user) =>
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM listening_progress WHERE user_id=? AND completed=1",
          )
          .get(user)
      ).count,
    favorites: async (user) =>
      (
        await db
          .prepare("SELECT COUNT(*) AS count FROM favorites WHERE user_id=?")
          .get(user)
      ).count,
    genres: (user) =>
      db
        .prepare(
          `SELECT s.genre,SUM(e.listening_seconds) AS "listeningSeconds" FROM listening_events e JOIN stories s ON s.id=e.story_id
      WHERE e.user_id=? AND e.listening_seconds>0 GROUP BY s.genre ORDER BY "listeningSeconds" DESC,s.genre`,
        )
        .all(user),
    activity: (user, since) =>
      db
        .prepare(
          `SELECT ${db.date} AS date,SUM(listening_seconds) AS "listeningSeconds" FROM listening_events
      WHERE user_id=? AND created_at>=? GROUP BY ${db.date}`,
        )
        .all(user, since),
    recent: (user) =>
      db
        .prepare(
          `SELECT e.event_id,e.event_type,e.created_at,e.listening_seconds,s.id AS story_id,s.title AS story_title,c.title AS chapter_title
      FROM listening_events e JOIN stories s ON s.id=e.story_id LEFT JOIN chapters c ON c.id=e.chapter_id
      WHERE e.user_id=? ORDER BY e.created_at DESC,${db.eventOrder} DESC LIMIT 20`,
        )
        .all(user),
  };
}
