import { openDatabase, seedDatabase } from "../db.js";
import { sqliteAdapter, postgresAdapter } from "./adapter.js";
import { migrate } from "./migrate.js";
import { seedCatalog } from "./seed.js";
import { loadConfig } from "../config.js";
export async function connectDatabase(env = process.env) {
  const config = loadConfig(env);
  if (env.DATABASE_URL) {
    const db = postgresAdapter(env.DATABASE_URL, {
      max: config.poolMax,
      ssl: env.PGSSL === "true" ? { rejectUnauthorized: true } : undefined,
    });
    try {
      await migrate(db);
      await seedCatalog(db);
      return db;
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  if (config.production && env.ALLOW_EPHEMERAL_SQLITE !== "true")
    throw new Error(
      "Production requires DATABASE_URL; explicit ALLOW_EPHEMERAL_SQLITE=true is limited to the portfolio demo",
    );
  const raw = openDatabase(env.DATABASE_PATH);
  seedDatabase(raw);
  return sqliteAdapter(raw);
}
