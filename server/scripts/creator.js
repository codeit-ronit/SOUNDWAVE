import { connectDatabase } from "../database/index.js";
import {
  provisionIdentity,
  validateProvisioning,
} from "../services/creator-operator.js";
const [action, user, value, confirmation, ...extra] = process.argv.slice(2);
if (
  confirmation !== "--confirm-operator" ||
  extra.length ||
  (!process.env.DATABASE_URL &&
    !(process.env.DATABASE_DRIVER === "sqlite" && process.env.DATABASE_PATH))
)
  throw Error(
    "Set an explicit DATABASE_URL (or DATABASE_DRIVER=sqlite and DATABASE_PATH). Usage: npm run identity:provision -- role|status ACCOUNT_UUID VALUE --confirm-operator. No dotenv is loaded.",
  );
validateProvisioning(action, user, value);
const db = await connectDatabase(process.env);
try {
  console.log(await provisionIdentity(db, action, user, value));
} finally {
  await db.close();
}
