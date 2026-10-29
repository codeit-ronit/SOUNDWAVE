import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
dotenv.config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});
import { createApp } from "./app.js";
import { openDatabase, seedDatabase } from "./db.js";
const db = openDatabase();
seedDatabase(db);
const port = Number(process.env.PORT || 3001);
const server = createApp(db).listen(port, () =>
  console.log(`SoundWave API + production app: http://127.0.0.1:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
