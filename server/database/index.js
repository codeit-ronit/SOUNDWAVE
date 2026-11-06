import { openDatabase, seedDatabase } from "../db.js";
import { sqliteAdapter, postgresAdapter } from "./adapter.js";
import { migrate } from "./migrate.js";
import { seedCatalog } from "./seed.js";
import { loadConfig } from "../config.js";
export async function connectDatabase(env = process.env) {
  const config = loadConfig(env);
  if (
    env.DATABASE_DRIVER &&
    !["postgres", "sqlite"].includes(env.DATABASE_DRIVER)
  )
    throw Error("Invalid DATABASE_DRIVER");
  if (env.DATABASE_DRIVER === "postgres" && !env.DATABASE_URL)
    throw Error("Set DATABASE_URL for PostgreSQL (primary)");
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
  if (
    !env.DATABASE_PATH &&
    env.DATABASE_DRIVER !== "sqlite" &&
    env.ALLOW_EPHEMERAL_SQLITE !== "true"
  )
    throw Error(
      "Set DATABASE_URL for PostgreSQL (primary), or explicitly select DATABASE_DRIVER=sqlite for compatibility",
    );
  const raw = openDatabase(env.DATABASE_PATH);
  seedDatabase(raw);
  return sqliteAdapter(raw);
}
