// Vercel demo adapter. /tmp is ephemeral; the normal Node server keeps durable SQLite.
let appPromise;
module.exports = async function handler(req, res) {
  appPromise ||= (async () => {
    const { openDatabase, seedDatabase } = await import("../server/db.js");
    const { createApp } = await import("../server/app.js");
    const db = openDatabase("/tmp/soundwave-demo.sqlite");
    seedDatabase(db);
    return createApp(db);
  })();
  return (await appPromise)(req, res);
};
