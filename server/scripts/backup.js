import dotenv from "dotenv";
import { backupDatabase, verifyBackup } from "../operations/backup.js";
dotenv.config({ path: new URL("../../.env", import.meta.url), quiet: true });
const [action, path] = process.argv.slice(2);
if (
  !process.env.DATABASE_URL ||
  !path ||
  !["create", "verify"].includes(action)
)
  throw Error(
    "Usage: DATABASE_URL=... npm run db:backup -- create|verify /absolute/path.dump",
  );
const options = { container: process.env.BACKUP_PG_CONTAINER };
if (action === "create") {
  const result = await backupDatabase(process.env.DATABASE_URL, path, options);
  console.log(
    `Backup created with SHA-256 integrity manifest (${Object.keys(result.tables).length} tables). Protect both files; they contain sensitive database data.`,
  );
} else
  console.log(
    await verifyBackup(
      process.env.RESTORE_ADMIN_URL || process.env.DATABASE_URL,
      path,
      options,
    ),
  );
