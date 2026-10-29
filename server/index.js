import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
dotenv.config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});
import { loadConfig } from "./config.js";
import { redisInfrastructure } from "./infrastructure/redis.js";
import { createApp } from "./app.js";
import { connectDatabase } from "./database/index.js";
import { retryConnection } from "./database/retry.js";
const db = await retryConnection(() => connectDatabase());
const config = loadConfig();
const redis = config.redisUrl
  ? redisInfrastructure(config.redisUrl, { prefix: config.redisPrefix })
  : null;
redis?.start();
const port = Number(process.env.PORT || 3001);
const server = createApp(db, { config, redis }).listen(port, () =>
  console.log(`SoundWave API + production app: http://127.0.0.1:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(async () => {
      await redis?.close();
      await db.close();
      process.exit(0);
    }),
  );
