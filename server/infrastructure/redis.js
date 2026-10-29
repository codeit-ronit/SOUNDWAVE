import { createClient } from "redis";
import { createHash } from "node:crypto";
const counterScript = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('PTTL',KEYS[1])}`;
export function redisInfrastructure(
  url,
  { prefix = "soundwave", timeoutMs = 750 } = {},
) {
  if (!/^[a-zA-Z0-9:_-]{1,80}$/.test(prefix))
    throw Error("Invalid REDIS_PREFIX");
  const client = createClient({
    url,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 200,
    socket: {
      connectTimeout: timeoutMs,
      reconnectStrategy: (retries) =>
        Math.min(100 * 2 ** Math.min(retries, 5), 3000),
    },
  });
  client.on("error", () => {}); // Never log connection URLs/credentials.
  const command = () =>
    client.withCommandOptions({ abortSignal: AbortSignal.timeout(timeoutMs) });
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  return {
    client,
    prefix,
    start: () => {
      void client.connect().catch(() => {});
    },
    ready: () => client.isReady,
    async consume(bucket, key, windowMs) {
      if (!client.isReady) throw Error("Redis unavailable");
      const result = await command().eval(counterScript, {
        keys: [`${prefix}:limit:${bucket}:${digest(key)}`],
        arguments: [String(windowMs)],
      });
      return {
        count: Number(result[0]),
        ttlMs: Math.max(1, Number(result[1])),
      };
    },
    async cached(revision, key, load) {
      const hash = digest(key),
        slot = parseInt(hash.slice(0, 8), 16) % 128;
      const cacheKey = `${prefix}:catalog:v2:${revision}:${slot}`;
      if (client.isReady)
        try {
          const raw = await command().get(cacheKey);
          if (raw) {
            const entry = JSON.parse(raw);
            if (entry.hash === hash) return entry.value;
          }
        } catch {}
      const value = await load();
      if (client.isReady)
        try {
          await command().set(cacheKey, JSON.stringify({ hash, value }), {
            EX: 60,
          });
        } catch {}
      return value;
    },
    async close() {
      if (client.isOpen) client.destroy();
    },
  };
}
