// SQL fragments contain only application-owned identifiers, never request input.
// Every public read checks live eligibility, independently of Redis metadata.
export const eligiblePublication = (s = "s", p = "pub") => `
 ${s}.ownership_kind='creator' AND ${s}.draft_state='draft'
 AND ${s}.draft_revision=${p}.story_revision
 AND EXISTS(SELECT 1 FROM users u JOIN creator_profiles cp ON cp.user_id=u.id WHERE u.id=${s}.owner_id AND u.kind='registered' AND cp.status='active')
 AND EXISTS(SELECT 1 FROM publication_chapters pc WHERE pc.story_id=${s}.id)
 AND (SELECT COUNT(*) FROM chapters ac WHERE ac.story_id=${s}.id AND ac.draft_removed=0)=(SELECT COUNT(*) FROM publication_chapters pc WHERE pc.story_id=${s}.id)
 AND NOT EXISTS(SELECT 1 FROM publication_chapters pc
 LEFT JOIN chapters ch ON ch.id=pc.chapter_id
 LEFT JOIN private_media_heads h ON h.chapter_id=ch.id
 LEFT JOIN private_media_assets a ON a.id=pc.asset_id
 LEFT JOIN private_processing_intents pi ON pi.asset_id=a.id
 LEFT JOIN private_media_outputs o ON o.id=pc.output_id
 WHERE pc.story_id=${s}.id AND (
 ch.id IS NULL OR ch.story_id<>${s}.id OR ch.draft_removed<>0 OR ch.draft_revision<>pc.chapter_revision OR ch.chapter_number<>pc.chapter_number
 OR h.asset_id IS NULL OR h.asset_id<>pc.asset_id OR h.revision<>pc.head_revision
 OR a.id IS NULL OR a.user_id<>${s}.owner_id OR a.story_id<>${s}.id OR a.chapter_id<>ch.id OR a.status<>'validated'
 OR pi.id IS NULL OR pi.status<>'ready' OR pi.processor_version<>1 OR pi.source_hash<>a.checksum OR pi.source_revision<>a.revision OR pi.head_revision<>h.revision
 OR o.id IS NULL OR o.intent_id<>pi.id OR o.status<>'ready' OR o.checksum<>pc.checksum OR o.storage_released<>0))`;
export const publicStory = (s = "s") =>
  `(${s}.ownership_kind IN ('system','external') OR EXISTS(SELECT 1 FROM story_publications pub WHERE pub.story_id=${s}.id AND pub.state='published' AND ${eligiblePublication(s)}))`;
export async function assertPublicationEditable(db, story) {
  const p = await db
    .prepare("SELECT state FROM story_publications WHERE story_id=?")
    .get(story);
  if (p && ["submitted", "approved", "published"].includes(p.state))
    throw Object.assign(
      Error(
        "Withdraw review or unpublish before editing. Changed content requires a new submission.",
      ),
      { status: 409, permissionCode: "PUBLICATION_LOCKED" },
    );
}
