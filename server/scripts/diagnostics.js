import { postgresAdapter } from "../database/adapter.js";
import { diagnostics } from "../routes/diagnostics.js";
if (!process.env.DATABASE_URL)
  throw Error("Explicit DATABASE_URL required; no dotenv is loaded");
const db = postgresAdapter(process.env.DATABASE_URL);
try {
  console.log(JSON.stringify(await diagnostics(db), null, 2));
} finally {
  await db.close();
}
