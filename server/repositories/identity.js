export function identityRepository(db) {
  return {
    upgradeGuest: (user) =>
      db
        .prepare(
          "UPDATE users SET email=?,password_hash=?,display_name=?,kind='registered' WHERE id=? AND kind='guest'",
        )
        .run(user.email, user.password_hash, user.display_name, user.id),
    userByEmail: (email) =>
      db.prepare("SELECT * FROM users WHERE email=?").get(email),
    createUser: (user) =>
      db
        .prepare(
          "INSERT INTO users(id,email,password_hash,display_name,kind) VALUES(@id,@email,@password_hash,@display_name,@kind)",
        )
        .run(user),
    session: (hash) =>
      db
        .prepare(
          `SELECT s.*,u.email,u.display_name,u.kind FROM sessions s LEFT JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND (s.user_id IS NULL OR u.kind IN ('registered','guest'))`,
        )
        .get(hash, new Date().toISOString()),
    createSession: (s) =>
      db
        .prepare(
          "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES(@token_hash,@user_id,@csrf_token,@expires_at)",
        )
        .run(s),
    deleteSession: (hash) =>
      db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash),
  };
}
