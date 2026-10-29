import { analyticsRepository } from "../repositories/analytics.js";
export async function analyticsOverview(db, user) {
  const repo = analyticsRepository(db);
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10),
  );
  const total = await repo.total(user),
    completed = await repo.completed(user),
    favorites = await repo.favorites(user);
  const genres = await repo.genres(user),
    activity = await repo.activity(user, `${days[0]}T00:00:00.000Z`),
    recentActivity = await repo.recent(user);
  return {
    totalListeningSeconds: Math.round(total * 1000) / 1000,
    completedChapters: completed,
    favoriteStories: favorites,
    genres,
    dailyActivity: days.map((date) => ({
      date,
      listeningSeconds:
        activity.find((row) => row.date === date)?.listeningSeconds || 0,
    })),
    recentActivity,
    measurement: "Recorded online playback wall time; seeks are excluded.",
  };
}
