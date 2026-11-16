import { telemetry } from "../telemetry.js";
import { processingIntents } from "../services/processing-intents.js";
import { localPrivateStorage } from "../storage/local-private.js";
import { transcodePrivateWav } from "./private-ffmpeg.js";
export async function processPrivateMedia(
  db,
  config,
  id,
  {
    signal,
    hooks = {},
    converter = transcodePrivateWav,
    storage = localPrivateStorage(config.privateMediaRoot),
  } = {},
) {
  const started = performance.now();
  let result = "failed";
  const service = processingIntents(db, config, storage),
    claim = await service.claim(id);
  if (!claim) {
    telemetry(db).observe(
      "processing_ms",
      "unchanged",
      performance.now() - started,
    );
    return { unchanged: true };
  }
  if (claim.intent?.attempts > 1)
    telemetry(db).observe("processing_retries", "retry");
  try {
    await hooks.afterClaim?.(claim);
    const metadata = await converter(
      storage,
      claim.source,
      claim.output,
      config,
      {
        signal,
        onStage: (stage) => service.stage(id, claim.token, stage),
        onOutput: hooks.onOutput,
      },
    );
    await hooks.afterOutput?.(claim);
    const committed = await service.commit(
      id,
      claim.token,
      claim.output.id,
      metadata,
    );
    await hooks.afterCommit?.(claim);
    await service.sweep();
    result = committed ? "ready" : "unchanged";
    return { ready: committed };
  } catch (e) {
    telemetry(db).observe("job_failures", "processing");
    const code = /^[A-Z_]{1,60}$/.test(e.code || "")
      ? e.code
      : "PROCESSING_FAILED";
    await service.fail(
      id,
      claim.token,
      code,
      [
        "SOURCE_HASH",
        "SOURCE_MISSING",
        "OUTPUT_INVALID",
        "FFMPEG_UNAVAILABLE",
      ].includes(code),
    );
    await service.sweep();
    throw Object.assign(Error(code), { code });
  } finally {
    telemetry(db).observe("processing_ms", result, performance.now() - started);
    await service.release(id, claim.token);
    await service.sweep();
  }
}
