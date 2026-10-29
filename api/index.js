// Vercel demo adapter. /tmp is ephemeral; the normal Node server keeps durable SQLite.
let appPromise;
module.exports = async function handler(req, res) {
  appPromise ||= (async () => {
    const { connectDatabase } = await import("../server/database/index.js");
    const { createApp } = await import("../server/app.js");
    const db = await connectDatabase({
      ...process.env,
      DATABASE_PATH: "/tmp/soundwave-demo.sqlite",
    });
    const { loadConfig } = await import("../server/config.js");
    const { redisInfrastructure } =
      await import("../server/infrastructure/redis.js");
    const config = loadConfig();
    const redis = config.redisUrl
      ? redisInfrastructure(config.redisUrl, { prefix: config.redisPrefix })
      : null;
    redis?.start();
    return createApp(db, { config, redis });
  })();
  appPromise = appPromise.catch((error) => {
    appPromise = null;
    throw error;
  });
  return (await appPromise)(req, res);
};
