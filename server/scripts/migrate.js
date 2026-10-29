import dotenv from "dotenv";
import { connectDatabase } from "../database/index.js";
import { importSqlite } from "../database/import-sqlite.js";
dotenv.config({ path: new URL("../../.env", import.meta.url), quiet: true });
const db = await connectDatabase();
try {
  if (process.argv[2])
    console.log(
      "Imported new rows; existing target keys preserved:",
      await importSqlite(db, process.argv[2]),
    );
  else console.log("Versioned migrations and catalog seed complete.");
} finally {
  await db.close();
}
