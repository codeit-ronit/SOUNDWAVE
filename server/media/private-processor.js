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
  const service = processingIntents(db, config, storage),
    claim = await service.claim(id);
  if (!claim) return { unchanged: true };
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
    return { ready: committed };
  } catch (e) {
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
    await service.release(id, claim.token);
    await service.sweep();
  }
}
