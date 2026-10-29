import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
dotenv.config({
  path: fileURLToPath(new URL("../../.env", import.meta.url)),
  quiet: true,
});
import { openDatabase, seedDatabase } from "../db.js";
const db = openDatabase();
seedDatabase(db);
console.log(
  "Seeded 6 original stories and 12 chapters. Listener data preserved.",
);
db.close();
