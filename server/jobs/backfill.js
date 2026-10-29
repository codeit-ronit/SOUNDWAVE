import { jobQueue } from "./queue.js";
export async function backfillRollups(db) {
  let count = 0;
  for (;;) {
    const days = await db
      .prepare(
        `WITH days AS (SELECT DISTINCT user_id,${db.date} AS day FROM listening_events WHERE listening_seconds>0)
   SELECT user_id,day FROM days d WHERE NOT EXISTS(SELECT 1 FROM background_jobs j WHERE j.dedupe_key='backfill:'||d.user_id||':'||d.day) ORDER BY user_id,day LIMIT 1000`,
      )
      .all();
    if (!days.length) return count;
    for (const row of days) {
      await jobQueue(db).enqueue("analytics_rollup", {
        owner: row.user_id,
        payload: { day: row.day },
        key: `backfill:${row.user_id}:${row.day}`,
      });
      count++;
    }
  }
}
