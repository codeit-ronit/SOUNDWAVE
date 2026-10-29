import express from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apiRouter } from "./routes/api.js";
export function createApp(db) {
  const app = express();
  app.disable("x-powered-by");
  const origins = (
    process.env.CLIENT_ORIGIN || "http://127.0.0.1:5173,http://localhost:5173"
  )
    .split(",")
    .map((s) => s.trim());
  app.use(
    cors({ origin: origins, methods: ["GET", "PUT", "DELETE", "OPTIONS"] }),
  );
  app.use(express.json({ limit: "8kb" }));
  app.use("/api", apiRouter(db));
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: { message: "API route not found." } }),
  );
  app.use(
    "/audio",
    express.static(fileURLToPath(new URL("./public/audio", import.meta.url)), {
      maxAge: "1d",
      fallthrough: false,
    }),
  );
  const client = fileURLToPath(new URL("../client/dist", import.meta.url));
  if (existsSync(client)) {
    app.use(express.static(client));
    app.get("/{*path}", (_req, res) => res.sendFile(`${client}/index.html`));
  }
  app.use((_req, res) =>
    res.status(404).json({ error: { message: "Resource not found." } }),
  );
  app.use((err, _req, res, _next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({
      error: {
        message:
          status === 500
            ? "Something went wrong. Please try again."
            : status === 413
              ? "Request body is too large."
              : status === 404
                ? "Resource not found."
                : "Invalid request body.",
      },
    });
  });
  return app;
}
