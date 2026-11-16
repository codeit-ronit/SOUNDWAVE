export function creatorRepository(db) {
  return {
    account: (id, lock = false) =>
      db
        .prepare(
          `SELECT id,kind,platform_role FROM users WHERE id=?${lock && db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
        )
        .get(id),
    profile: (id) =>
      db
        .prepare(
          "SELECT user_id,display_name,bio,status,created_at,updated_at FROM creator_profiles WHERE user_id=?",
        )
        .get(id),
    create: (id, name, bio) =>
      db
        .prepare(
          "INSERT INTO creator_profiles(user_id,display_name,bio) VALUES(?,?,?)",
        )
        .run(id, name, bio),
    edit: (id, name, bio) =>
      db
        .prepare(
          `UPDATE creator_profiles SET display_name=?,bio=?,updated_at=${db.now} WHERE user_id=?`,
        )
        .run(name, bio, id),
    status: (id, status) =>
      db
        .prepare(
          `UPDATE creator_profiles SET status=?,updated_at=${db.now} WHERE user_id=?`,
        )
        .run(status, id),
    story: (id) =>
      db
        .prepare("SELECT id,owner_id,ownership_kind FROM stories WHERE id=?")
        .get(id),
  };
}
