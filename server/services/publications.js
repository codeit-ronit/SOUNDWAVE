import { localPrivateStorage } from "../storage/local-private.js";
import { loadConfig } from "../config.js";
import { createHash, randomUUID } from "node:crypto";
import { authorizationService, permissionError } from "./authorization.js";
import { eligiblePublication } from "./publication-visibility.js";
export const RIGHTS_TERMS = "creator-rights-v1";
export const decisionCodes = [
  "approved",
  "rights_concern",
  "content_policy",
  "audio_quality",
  "metadata_issue",
];
const fail = (status, code, message) => {
  throw permissionError(status, code, message);
};
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
const view = (p) =>
  p
    ? {
        storyId: p.story_id,
        state: p.state,
        revision: p.revision,
        termsVersion: p.terms_version,
        attestedAt: p.attested_at,
        submittedAt: p.submitted_at,
        decidedAt: p.decided_at,
        decisionCode: p.decision_code,
        decisionNote: p.decision_note,
        publishedAt: p.published_at,
        revokedAt: p.revoked_at,
      }
    : null;
// Caller holds the owner lock. Used by trusted operator and account deactivation.
export async function revokeCreatorPublications(
  db,
  owner,
  actor,
  action = "suspend",
  operator = true,
  note = "",
) {
  const rows = await db
    .prepare(
      "SELECT p.* FROM story_publications p JOIN stories s ON s.id=p.story_id WHERE s.owner_id=? AND p.state IN ('submitted','approved','published','unpublished') ORDER BY p.story_id",
    )
    .all(owner);
  for (const p of rows) {
    if (p.revision >= Number.MAX_SAFE_INTEGER)
      fail(409, "REVISION_EXHAUSTED", "Publication revision exhausted.");
    const t = now();
    await db
      .prepare(
        "UPDATE story_publications SET state='revoked',revision=revision+1,revoked_at=?,updated_at=?,decision_code='creator_inactive' WHERE story_id=?",
      )
      .run(t, t, p.story_id);
    await db
      .prepare(
        "INSERT INTO publication_audit(id,story_id,actor_id,action,revision,snapshot_hash,decision_code,note,created_at,actor_kind) VALUES(?,?,?,?,?,?,'creator_inactive',?,?,?)",
      )
      .run(
        randomUUID(),
        p.story_id,
        actor,
        action,
        p.revision + 1,
        p.snapshot_hash,
        note,
        t,
        operator ? "operator" : "account",
      );
  }
  if (rows.length)
    await db
      .prepare("UPDATE catalog_revision SET revision=? WHERE id=1")
      .run(randomUUID());
}
export function publicationService(
  db,
  config = loadConfig(),
  storage = localPrivateStorage(config.privateMediaRoot),
) {
  const auth = authorizationService(db);
  const get = (id) =>
    db.prepare("SELECT * FROM story_publications WHERE story_id=?").get(id);
  async function scope(principal, id, staff = false) {
    const s = await db.prepare("SELECT * FROM stories WHERE id=?").get(id);
    if (!s || s.ownership_kind !== "creator")
      fail(404, "PUBLICATION_NOT_FOUND", "Publication not found.");
    // Sorted non-key account locks block role/status mutation but allow FK KEY SHARE
    // checks by a creator publishing an already staff-approved row. FOR UPDATE
    // here can deadlock with that row’s decided_by foreign key.
    for (const user of [...new Set([s.owner_id, principal.id])].sort())
      await db
        .prepare(
          `SELECT id FROM users WHERE id=?${db.dialect === "postgres" ? " FOR NO KEY UPDATE" : ""}`,
        )
        .get(user);
    if (staff) await auth.staff(principal, ["moderator", "admin"]);
    else await auth.ownedStory(principal, id);
    return db.prepare("SELECT * FROM stories WHERE id=?").get(id);
  }
  async function snapshot(s) {
    if (s.draft_state !== "draft")
      fail(409, "NOT_READY", "Archived content cannot be submitted.");
    const cp = await db
      .prepare("SELECT status FROM creator_profiles WHERE user_id=?")
      .get(s.owner_id);
    if (cp?.status !== "active") fail(409, "NOT_READY", "Creator is inactive.");
    const chapters = await db
      .prepare(
        `SELECT c.id,c.title,c.summary,c.chapter_number,c.draft_revision,h.asset_id,h.revision AS head_revision,a.checksum AS source_hash,a.revision AS source_revision,p.source_revision AS processed_source_revision,p.head_revision AS processed_head_revision,p.source_hash AS processed_source_hash,p.processor_version,o.id AS output_id,o.checksum,o.duration_seconds,o.object_key,o.byte_size
 FROM chapters c LEFT JOIN private_media_heads h ON h.chapter_id=c.id LEFT JOIN private_media_assets a ON a.id=h.asset_id AND a.status='validated' AND a.user_id=? LEFT JOIN private_processing_intents p ON p.asset_id=a.id AND p.status='ready' LEFT JOIN private_media_outputs o ON o.intent_id=p.id AND o.status='ready' AND o.storage_released=0
 WHERE c.story_id=? AND c.draft_removed=0 ORDER BY c.chapter_number,c.id LIMIT 101`,
      )
      .all(s.owner_id, s.id);
    if (
      !chapters.length ||
      chapters.length > 100 ||
      chapters.some(
        (c) =>
          !c.output_id ||
          !c.source_hash ||
          c.processor_version !== 1 ||
          c.source_hash !== c.processed_source_hash ||
          c.source_revision !== c.processed_source_revision ||
          c.head_revision !== c.processed_head_revision,
      )
    )
      fail(
        409,
        "NOT_READY",
        "Every chapter needs a current ready MP3 before submission or publication.",
      );
    for (const c of chapters) {
      let h;
      try {
        h = await storage.read(c.object_key);
        if ((await h.stat()).size !== c.byte_size)
          fail(409, "NOT_READY", "Processed media needs recovery.");
        const digest = createHash("sha256");
        for await (const chunk of h.createReadStream({ autoClose: false }))
          digest.update(chunk);
        if (digest.digest("hex") !== c.checksum)
          fail(409, "NOT_READY", "Processed media checksum changed.");
      } catch (e) {
        if (e.permissionCode) throw e;
        fail(409, "NOT_READY", "Processed media is unavailable.");
      } finally {
        await h?.close().catch(() => {});
      }
    }
    // Hash stable public/review identity, never a path or environment-specific key.
    for (const c of chapters) {
      delete c.object_key;
    }
    return {
      chapters,
      hash: hash({
        story: [
          s.id,
          s.title,
          s.description,
          s.genre,
          s.language,
          s.author,
          s.draft_revision,
        ],
        chapters,
      }),
    };
  }
  async function detail(id, staff = false) {
    const p = await get(id);
    return {
      publication: view(p),
      termsVersion: RIGHTS_TERMS,
      audit: p
        ? await db
            .prepare(
              `SELECT action,revision,terms_version AS \"termsVersion\",attested_at AS \"attestedAt\",actor_kind AS \"actorKind\",decision_code AS code,note,created_at AS at${staff ? ',actor_id AS "actorId"' : ""} FROM publication_audit WHERE story_id=? ORDER BY revision DESC LIMIT 100`,
            )
            .all(id)
        : [],
    };
  }
  return {
    read: (principal, id, staff = false) =>
      db.transaction(async () => {
        await scope(principal, id, staff);
        const p = await get(id);
        if (staff && (!p || p.state === "draft"))
          fail(404, "PUBLICATION_NOT_FOUND", "Publication not found.");
        const data = await detail(id, staff);
        if (staff) {
          const s = await db
            .prepare(
              "SELECT title,description,genre,language FROM stories WHERE id=?",
            )
            .get(id);
          // Review metadata must match submission. Never provide staff an arbitrary draft preview.
          const eligible = await db
            .prepare(
              `SELECT s.id FROM stories s JOIN story_publications pub ON pub.story_id=s.id WHERE s.id=? AND ${eligiblePublication()}`,
            )
            .get(id);
          data.story = eligible ? s : null;
          data.current = !!eligible;
          data.chapters = eligible
            ? await db
                .prepare(
                  'SELECT c.id,c.title,c.summary,pc.output_id AS "outputId" FROM publication_chapters pc JOIN chapters c ON c.id=pc.chapter_id WHERE pc.story_id=? ORDER BY pc.chapter_number LIMIT 100',
                )
                .all(id)
            : [];
        }
        return data;
      }),
    pending: (principal) =>
      db.transaction(async () => {
        await auth.staff(principal, ["moderator", "admin"]);
        return {
          submissions: await db
            .prepare(
              'SELECT p.story_id AS "storyId",p.revision,p.submitted_at AS "submittedAt",s.title FROM story_publications p JOIN stories s ON s.id=p.story_id WHERE p.state=\'submitted\' ORDER BY p.story_id LIMIT 50',
            )
            .all(),
        };
      }),
    transition: (principal, id, action, b) =>
      db.transaction(async () => {
        const staff = ["approve", "reject", "revoke", "suspend"].includes(
            action,
          ),
          s = await scope(principal, id, staff);
        if (staff && s.owner_id === principal.id)
          fail(403, "SELF_REVIEW", "Staff cannot moderate their own content.");
        const fingerprint = hash({ id, action, ...b }),
          receipt = await db
            .prepare(
              "SELECT * FROM publication_receipts WHERE actor_id=? AND request_id=?",
            )
            .get(principal.id, b.requestId);
        if (receipt) {
          if (receipt.story_id !== id || receipt.request_hash !== fingerprint)
            fail(409, "REQUEST_REUSED", "Request ID already used.");
          return { ...(await detail(id, staff)), replayed: true };
        }
        let p = await get(id);
        if ((p?.revision ?? 0) !== b.expectedRevision)
          fail(
            409,
            "PUBLICATION_CONFLICT",
            "Publication changed. Refresh before deciding.",
          );
        if ((p?.revision ?? 0) >= Number.MAX_SAFE_INTEGER)
          fail(409, "REVISION_EXHAUSTED", "Publication revision exhausted.");
        if (action === "suspend") {
          await auth.staff(principal, ["admin"]);
          if (
            !p ||
            !["submitted", "approved", "published", "unpublished"].includes(
              p.state,
            )
          )
            fail(
              409,
              "INVALID_TRANSITION",
              "Active review/publication required.",
            );
          if (!decisionCodes.slice(1).includes(b.code))
            fail(
              400,
              "INVALID_DECISION",
              "Choose a controlled suspension reason.",
            );
          await db
            .prepare(
              "UPDATE creator_profiles SET status='suspended' WHERE user_id=?",
            )
            .run(s.owner_id);
          await revokeCreatorPublications(
            db,
            s.owner_id,
            principal.id,
            "suspend",
            false,
            b.note,
          );
          await db
            .prepare(
              "INSERT INTO publication_receipts(actor_id,request_id,story_id,request_hash) VALUES(?,?,?,?)",
            )
            .run(principal.id, b.requestId, id, fingerprint);
          return { ...(await detail(id, true)), replayed: false };
        }
        const state = p?.state ?? "draft",
          t = now();
        let target,
          code = b.code ?? null,
          note = b.note ?? "",
          snap;
        if (action === "submit") {
          if (
            ![
              "draft",
              "rejected",
              "withdrawn",
              "unpublished",
              "revoked",
            ].includes(state)
          )
            fail(
              409,
              "INVALID_TRANSITION",
              "Withdraw review or unpublish first.",
            );
          if (b.attest !== true || b.termsVersion !== RIGHTS_TERMS)
            fail(
              400,
              "RIGHTS_REQUIRED",
              "Accept the current rights declaration.",
            );
          snap = await snapshot(s);
          target = "submitted";
        } else if (action === "withdraw") {
          if (!["submitted", "approved"].includes(state))
            fail(
              409,
              "INVALID_TRANSITION",
              "Only pending/approved review may be withdrawn.",
            );
          target = "withdrawn";
        } else if (action === "approve" || action === "reject") {
          if (state !== "submitted")
            fail(
              409,
              "INVALID_TRANSITION",
              "Only submitted content may be reviewed.",
            );
          snap = await snapshot(s);
          if (snap.hash !== p.snapshot_hash)
            fail(
              409,
              "STALE_REVIEW",
              "Content changed. Creator must withdraw and resubmit.",
            );
          if (
            (action === "approve" && code !== "approved") ||
            (action === "reject" && !decisionCodes.slice(1).includes(code))
          )
            fail(400, "INVALID_DECISION", "Choose a controlled decision code.");
          target = action === "approve" ? "approved" : "rejected";
        } else if (action === "publish") {
          if (
            !["approved", "unpublished"].includes(state) ||
            p.decision_code !== "approved"
          )
            fail(409, "INVALID_TRANSITION", "Current approval required.");
          snap = await snapshot(s);
          if (snap.hash !== p.snapshot_hash || p.terms_version !== RIGHTS_TERMS)
            fail(
              409,
              "STALE_APPROVAL",
              "Content changed. Resubmit for review.",
            );
          target = "published";
        } else if (action === "unpublish") {
          if (state !== "published")
            fail(
              409,
              "INVALID_TRANSITION",
              "Only published content may be unpublished.",
            );
          target = "unpublished";
        } else if (action === "revoke") {
          if (
            !["submitted", "approved", "published", "unpublished"].includes(
              state,
            )
          )
            fail(
              409,
              "INVALID_TRANSITION",
              "Content has no active review/publication to revoke.",
            );
          if (!decisionCodes.slice(1).includes(code))
            fail(400, "INVALID_DECISION", "Choose a revocation code.");
          target = "revoked";
        } else fail(400, "INVALID_ACTION", "Unsupported action.");
        if (!p) {
          await db
            .prepare(
              "INSERT INTO story_publications(story_id,story_revision,updated_at) VALUES(?,?,?)",
            )
            .run(id, s.draft_revision, t);
          p = await get(id);
        }
        if (action === "submit") {
          await db
            .prepare("DELETE FROM publication_chapters WHERE story_id=?")
            .run(id);
          for (const c of snap.chapters)
            await db
              .prepare(
                "INSERT INTO publication_chapters(story_id,chapter_id,chapter_revision,chapter_number,asset_id,head_revision,output_id,checksum) VALUES(?,?,?,?,?,?,?,?)",
              )
              .run(
                id,
                c.id,
                c.draft_revision,
                c.chapter_number,
                c.asset_id,
                c.head_revision,
                c.output_id,
                c.checksum,
              );
          await db
            .prepare(
              "UPDATE story_publications SET story_revision=?,snapshot_hash=?,terms_version=?,attested_by=?,attested_at=?,submitted_at=?,decided_by=NULL,decided_at=NULL,decision_code=NULL,decision_note='',published_at=NULL,revoked_at=NULL WHERE story_id=?",
            )
            .run(
              s.draft_revision,
              snap.hash,
              RIGHTS_TERMS,
              principal.id,
              t,
              t,
              id,
            );
        }
        if (action === "approve" || action === "reject")
          await db
            .prepare(
              "UPDATE story_publications SET decided_by=?,decided_at=?,decision_code=?,decision_note=? WHERE story_id=?",
            )
            .run(principal.id, t, code, note, id);
        if (action === "publish") {
          for (const c of snap.chapters)
            await db
              .prepare("UPDATE chapters SET duration_seconds=? WHERE id=?")
              .run(c.duration_seconds, c.id);
          await db
            .prepare(
              "UPDATE story_publications SET published_at=? WHERE story_id=?",
            )
            .run(t, id);
        }
        if (action === "revoke" || action === "unpublish")
          await db
            .prepare(
              "UPDATE story_publications SET revoked_at=? WHERE story_id=?",
            )
            .run(t, id);
        if (action === "revoke")
          await db
            .prepare(
              "UPDATE story_publications SET decision_code=?,decision_note=? WHERE story_id=?",
            )
            .run(code, note, id);
        // Initial row starts at revision 1, initial transition is also revision 1.
        const next = b.expectedRevision + 1;
        await db
          .prepare(
            "UPDATE story_publications SET state=?,revision=?,updated_at=? WHERE story_id=?",
          )
          .run(target, next, t, id);
        await db
          .prepare(
            "INSERT INTO publication_audit(id,story_id,actor_id,action,revision,snapshot_hash,decision_code,note,created_at,terms_version,attested_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            randomUUID(),
            id,
            principal.id,
            action,
            next,
            (await get(id)).snapshot_hash,
            code,
            note,
            t,
            action === "submit" ? RIGHTS_TERMS : null,
            action === "submit" ? t : null,
          );
        await db
          .prepare(
            "INSERT INTO publication_receipts(actor_id,request_id,story_id,request_hash) VALUES(?,?,?,?)",
          )
          .run(principal.id, b.requestId, id, fingerprint);
        await db
          .prepare("UPDATE catalog_revision SET revision=? WHERE id=1")
          .run(randomUUID());
        return { ...(await detail(id, staff)), replayed: false };
      }),
  };
}
