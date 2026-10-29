import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";
import request from "supertest";
import { openDatabase, seedDatabase } from "../db.js";
import { sqliteAdapter, postgresAdapter } from "../database/adapter.js";
import { migrate } from "../database/migrate.js";
import { seedCatalog } from "../database/seed.js";
import { loadConfig } from "../config.js";
import { createApp } from "../app.js";
export const backends = [
  "sqlite",
  ...(process.env.TEST_DATABASE_URL ? ["postgres"] : []),
];
export const password = "a strong test password for SoundWave!";
export async function fixture(
  kind,
  { email = false, redis, config: overrides = {} } = {},
) {
  let db, admin, schema;
  if (kind === "postgres") {
    admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    schema = "phase2_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = postgresAdapter(process.env.TEST_DATABASE_URL, { schema });
    await migrate(db);
    await seedCatalog(db);
  } else {
    const raw = openDatabase(":memory:");
    seedDatabase(raw);
    db = sqliteAdapter(raw);
  }
  const config = {
    ...loadConfig({
      APP_ORIGIN: "http://localhost:3001",
      ...(email
        ? {
            EMAIL_MODE: "smtp",
            SMTP_URL: "smtp://127.0.0.1:51025",
            EMAIL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
          }
        : {}),
    }),
    ...overrides,
  };
  const app = createApp(db, { config, redis });
  async function client() {
    const agent = request.agent(app);
    let data = (await agent.get("/api/auth/session").expect(200)).body;
    return {
      agent,
      get data() {
        return data;
      },
      get: (path) => agent.get("/api" + path),
      async auth(action, body) {
        const response = await agent
          .post("/api/auth/" + action)
          .set("X-CSRF-Token", data.csrfToken)
          .send(body);
        if (response.status === 200 && response.body.csrfToken)
          data = response.body;
        return response;
      },
      write: (method, path, body) =>
        agent[method]("/api" + path)
          .set("X-CSRF-Token", data.csrfToken)
          .send(body),
    };
  }
  return {
    db,
    app,
    config,
    client,
    close: async () => {
      await db.close();
      if (admin) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    },
  };
}
