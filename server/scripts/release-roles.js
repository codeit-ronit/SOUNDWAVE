import pg from "pg";
import { createReleaseRoles } from "../operations/release-roles.js";
if (
  process.argv.slice(2).join(" ") !== "--confirm-operator" ||
  !process.env.DATABASE_URL
)
  throw Error(
    "Explicit administrator DATABASE_URL and --confirm-operator required; no dotenv loaded.",
  );
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await createReleaseRoles(client, {
    migratorPassword: process.env.MIGRATOR_PASSWORD,
    runtimePassword: process.env.RUNTIME_PASSWORD,
  });
  console.log(
    "Distinct migration/runtime roles created. No credentials printed.",
  );
} catch {
  console.error(
    "Role bootstrap failed; inspect protected database logs. Existing roles are never overwritten.",
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
