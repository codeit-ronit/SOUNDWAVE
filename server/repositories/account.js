export function accountRepository(db) {
  return {
    profile: (user) =>
      db
        .prepare(
          "SELECT u.*,EXISTS(SELECT 1 FROM oauth_identities i WHERE i.user_id=u.id AND i.provider='google') AS has_google FROM users u WHERE u.id=?",
        )
        .get(user),
    lockOwner: (user) =>
      db
        .prepare(
          `SELECT id FROM users WHERE id=?${db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
        )
        .get(user),
    rename: (user, name) =>
      db.prepare("UPDATE users SET display_name=? WHERE id=?").run(name, user),
    settings: (user) =>
      db
        .prepare(
          "SELECT playback_speed,autoplay_next,default_volume,updated_at FROM user_preferences WHERE user_id=?",
        )
        .get(user),
    save: (user, settings) =>
      db
        .prepare(
          `INSERT INTO user_preferences(user_id,playback_speed,autoplay_next,default_volume,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET playback_speed=excluded.playback_speed,autoplay_next=excluded.autoplay_next,default_volume=excluded.default_volume,updated_at=excluded.updated_at`,
        )
        .run(
          user,
          settings.playbackSpeed,
          Number(settings.autoplayNext),
          settings.defaultVolume,
          new Date().toISOString(),
        ),
  };
}
