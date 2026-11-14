import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
dotenv.config({
  path: fileURLToPath(new URL("../../.env", import.meta.url)),
  quiet: true,
});
import { connectDatabase } from "../database/index.js";
const db = await connectDatabase({ ...process.env, DATABASE_INIT: "migrate" });
console.log("Migrations and catalog seed complete. Listener data preserved.");
await db.close();
