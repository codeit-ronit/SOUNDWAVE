import { readFile, writeFile } from "node:fs/promises";
import { postgresAdapter } from "../database/adapter.js";
import {
  exportTakedowns,
  reconcileTakedowns,
} from "../operations/takedowns.js";
const [action, path, confirmation] = process.argv.slice(2);
if (
  !["export", "reconcile"].includes(action) ||
  !path ||
  confirmation !== "--confirm-operator" ||
  !process.env.DATABASE_URL ||
  process.env.RELEASE_QUARANTINED !== "true"
)
  throw Error(
    "Require explicit DATABASE_URL, RELEASE_QUARANTINED=true, export|reconcile FILE --confirm-operator; no dotenv is loaded",
  );
const db = postgresAdapter(process.env.DATABASE_URL);
try {
  if (action === "export") {
    await writeFile(
      path,
      JSON.stringify(await exportTakedowns(db), null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    console.log("Protected takedown ledger exported.");
  } else {
    const data = await readFile(path);
    if (data.length > 1048576) throw Error("Ledger exceeds 1 MiB");
    console.log(JSON.stringify(await reconcileTakedowns(db, JSON.parse(data))));
  }
} finally {
  await db.close();
}
