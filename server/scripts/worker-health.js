import { readFileSync } from "node:fs";
try {
  const state = JSON.parse(
    readFileSync(
      process.env.WORKER_HEALTH_FILE || "/tmp/soundwave-worker-health.json",
      "utf8",
    ),
  );
  if (
    (state.mediaEnabled && !state.mediaReady) ||
    Date.now() - state.at > 120000
  )
    process.exit(1);
  process.kill(state.pid, 0);
} catch {
  process.exit(1);
}
