import { progressFailure } from "./progress-error.js";
export async function lockHistoryOwner(db, user) {
  const row = await db
    .prepare(
      `SELECT id,history_revision FROM users WHERE id=?${db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
    )
    .get(user);
  if (!row)
    throw progressFailure(404, "ACCOUNT_NOT_FOUND", "Account not found.");
  return row;
}
export async function advanceHistory(db, user) {
  const row = await db
    .prepare("SELECT history_revision FROM users WHERE id=?")
    .get(user);
  if (row.history_revision >= Number.MAX_SAFE_INTEGER)
    throw progressFailure(
      409,
      "HISTORY_REVISION_LIMIT",
      "History revision limit reached.",
    );
  await db
    .prepare("UPDATE users SET history_revision=history_revision+1 WHERE id=?")
    .run(user);
  return row.history_revision + 1;
}
export const historyNow = (db) =>
  db.dialect === "postgres" ? "clock_timestamp()" : db.now;
