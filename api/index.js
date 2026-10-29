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
    return createApp(db);
  })();
  appPromise = appPromise.catch((error) => {
    appPromise = null;
    throw error;
  });
  return (await appPromise)(req, res);
};
