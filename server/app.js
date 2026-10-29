import { accountRecovery } from "./services/accountRecovery.js";
import { sqliteAdapter } from "./database/adapter.js";
import { loadConfig } from "./config.js";
import { authService } from "./services/auth.js";
import { identityMiddleware, csrfProtection } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { requestContext, apiRateLimit } from "./middleware/http.js";
import express from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyticsRouter } from "./routes/analytics.js";
import { streamRouter, legacyAudioRouter } from "./routes/stream.js";
import { apiRouter } from "./routes/api.js";
export function createApp(
  db,
  {
    logger = process.env.HTTP_LOG === "1"
      ? (record) => console.log(JSON.stringify(record))
      : null,
    rateLimit,
    config = loadConfig(),
    identity: injectedIdentity,
    csrf: injectedCsrf,
    authLimit,
    redis,
  } = {},
) {
  db = sqliteAdapter(db);
  const app = express();
  const service = authService(db, config);
  app.disable("x-powered-by");
  if (config.trustedProxies?.length)
    app.set("trust proxy", config.trustedProxies);
  app.use(requestContext(logger));
  const origins = new Set([
    config.origin,
    ...(!config.production
      ? (
          process.env.CLIENT_ORIGIN ||
          "http://127.0.0.1:5173,http://localhost:5173"
        )
          .split(",")
          .map((s) => s.trim())
      : []),
  ]);
  app.use(
    ["/api", "/audio"],
    cors({
      origin: (origin, cb) => cb(null, !!origin && origins.has(origin)),
      credentials: true,
      methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  );
  app.get("/api/ready", async (_req, res) => {
    await db.prepare("SELECT 1").get();
    const ready = !redis || redis.ready();
    res
      .status(ready ? 200 : 503)
      .set("Cache-Control", "no-store")
      .json({
        database: "ok",
        redis: redis ? (ready ? "ready" : "unavailable") : "not-configured",
      });
  });
  app.use("/api", apiRateLimit({ ...rateLimit, store: redis }));
  app.use(express.json({ limit: "8kb" }));
  app.use("/api", injectedIdentity || identityMiddleware(service, config));
  app.use(
    "/api/auth",
    authRouter(service, config, {
      authLimit,
      redis,
      recovery: accountRecovery(db, config),
    }),
  );
  app.use("/api", injectedCsrf || csrfProtection(config));
  app.use("/api", streamRouter(db));
  app.use("/api", analyticsRouter(db));
  app.use(
    "/api",
    apiRouter(db, { cache: config.catalogCacheEnabled ? redis : null }),
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: { message: "API route not found." } }),
  );
  app.use("/audio", legacyAudioRouter(db));
  const client = fileURLToPath(new URL("../client/dist", import.meta.url));
  if (existsSync(client)) {
    app.use(express.static(client));
    app.get("/{*path}", (_req, res) => res.sendFile(`${client}/index.html`));
  }
  app.use((_req, res) =>
    res.status(404).json({ error: { message: "Resource not found." } }),
  );
  app.use((err, _req, res, _next) => {
    const status = err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status === 500)
      console.error("Unhandled API error:", err.code || err.name);
    res.status(status).json({
      error: {
        message:
          status === 500
            ? "Something went wrong. Please try again."
            : status === 413
              ? "Request body is too large."
              : status === 404
                ? "Resource not found."
                : err.status
                  ? err.message
                  : "Invalid request body.",
      },
    });
  });
  return app;
}
