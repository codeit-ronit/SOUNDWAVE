// Fixed metric names and enums only. No SQL, paths, principals or object identities.
const schema = Object.freeze({
  http_ms: [
    "catalog",
    "progress",
    "playlists",
    "history",
    "stream",
    "creator",
    "moderation",
    "auth",
    "internal",
    "other",
  ],
  http_errors: ["4xx", "5xx", "aborted"],
  db_query_ms: ["read", "write", "error"],
  db_transaction_ms: ["ok", "error"],
  publication_ms: ["prepare", "verify", "commit", "revoke"],
  job_ms: ["maintenance", "analytics_rollup", "send_email", "other"],
  job_failures: ["outbox", "processing"],
  processing_ms: ["ready", "failed", "unchanged"],
  processing_retries: ["retry"],
  storage_failures: ["stream", "cleanup", "integrity"],
});
const registries = new WeakMap(),
  buckets = [1, 5, 10, 25, 50, 100, 250, 1000, 5000, 30000, Infinity];
export function telemetry(db) {
  if (!registries.has(db)) {
    const cells = new Map();
    registries.set(db, {
      observe(name, label, value = 1) {
        if (
          !schema[name]?.includes(label) ||
          !Number.isFinite(value) ||
          value < 0
        )
          return;
        const key = name + ":" + label;
        let c = cells.get(key);
        if (!c) {
          c = {
            name,
            label,
            count: 0,
            sum: 0,
            max: 0,
            buckets: buckets.map((le) => ({
              le: Number.isFinite(le) ? le : "+Inf",
              count: 0,
            })),
          };
          cells.set(key, c);
        }
        c.count++;
        c.sum += value;
        c.max = Math.max(c.max, value);
        for (let i = 0; i < buckets.length; i++)
          if (value <= buckets[i]) c.buckets[i].count++;
      },
      snapshot() {
        return JSON.parse(JSON.stringify([...cells.values()]));
      },
    });
  }
  return registries.get(db);
}
export function routeCategory(path) {
  if (/^\/(api\/)?chapters\/[^/]+\/stream$/.test(path)) return "stream";
  for (const [name, re] of [
    ["internal", /^\/(api\/)?internal(?:\/|$)/],
    ["moderation", /^\/(api\/)?moderation(?:\/|$)/],
    ["creator", /^\/(api\/)?creator(?:\/|$)/],
    ["auth", /^\/(api\/)?auth(?:\/|$)/],
    ["progress", /^\/(api\/)?progress(?:\/|$)/],
    ["playlists", /^\/(api\/)?playlists(?:\/|$)/],
    ["history", /^\/(api\/)?history(?:\/|$)/],
    ["catalog", /^\/(api\/)?(?:stories|genres|recommendations)(?:\/|$)/],
  ])
    if (re.test(path)) return name;
  return "other";
}
