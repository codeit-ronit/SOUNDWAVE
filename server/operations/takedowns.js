import { publicStory } from "../services/publication-visibility.js";
import { randomUUID } from "node:crypto";
// Operator-only module: never mounted as a client-controlled HTTP operation.
export async function exportTakedowns(db) {
  const rows = await db
    .prepare(
      `SELECT p.story_id AS id,p.revision FROM story_publications p JOIN stories s ON s.id=p.story_id WHERE NOT ${publicStory()} ORDER BY p.story_id LIMIT 10001`,
    )
    .all();
  if (rows.length > 10000)
    throw Error(
      "Export exceeds supported ledger size; keep service quarantined.",
    );
  return { version: 1, exportedAt: new Date().toISOString(), entries: rows };
}
export async function reconcileTakedowns(db, ledger) {
  if (
    !ledger ||
    ledger.version !== 1 ||
    !Array.isArray(ledger.entries) ||
    ledger.entries.length > 10000 ||
    ledger.entries.some(
      (e) =>
        !e ||
        Object.keys(e).some((k) => !["id", "revision"].includes(k)) ||
        !Number.isSafeInteger(e.id) ||
        e.id < 1 ||
        e.id > 999999999 ||
        !Number.isSafeInteger(e.revision) ||
        e.revision < 1 ||
        e.revision >= Number.MAX_SAFE_INTEGER,
    ) ||
    new Set(ledger.entries.map((e) => e.id)).size !== ledger.entries.length
  )
    throw Error("Invalid bounded takedown ledger");
  return db.transaction(async () => {
    // Match publication locking order across every affected creator before writes.
    const targets = [];
    for (const e of ledger.entries) {
      const p = await db
        .prepare(
          "SELECT s.owner_id FROM story_publications p JOIN stories s ON s.id=p.story_id WHERE p.story_id=?",
        )
        .get(e.id);
      if (p) targets.push(p.owner_id);
    }
    for (const owner of [...new Set(targets)].sort())
      await db
        .prepare(
          `SELECT id FROM users WHERE id=?${db.dialect === "postgres" ? " FOR NO KEY UPDATE" : ""}`,
        )
        .get(owner);
    let changed = 0;
    for (const e of ledger.entries) {
      const p = await db
        .prepare(
          "SELECT p.*,s.owner_id FROM story_publications p JOIN stories s ON s.id=p.story_id WHERE p.story_id=?",
        )
        .get(e.id);
      if (!p) continue;
      if (p.state === "revoked" && p.revision > e.revision) continue;
      const revision = Math.max(e.revision, p.revision) + 1;
      if (revision > Number.MAX_SAFE_INTEGER)
        throw Error("Publication revision exhausted");
      const at = new Date().toISOString();
      await db
        .prepare(
          "UPDATE story_publications SET state='revoked',revision=?,revoked_at=?,updated_at=?,decision_code='restore_takedown',decision_note='Operator reconciled later takedown before reopening.' WHERE story_id=?",
        )
        .run(revision, at, at, e.id);
      await db
        .prepare(
          "INSERT INTO publication_audit(id,story_id,actor_id,actor_kind,action,revision,snapshot_hash,decision_code,note,created_at) VALUES(?,?,?,'operator','revoke',?,?,'restore_takedown','Operator reconciled later takedown before reopening.',?)",
        )
        .run(randomUUID(), e.id, p.owner_id, revision, p.snapshot_hash, at);
      changed++;
    }
    if (changed)
      await db
        .prepare("UPDATE catalog_revision SET revision=? WHERE id=1")
        .run(randomUUID());
    return { changed };
  });
}
