export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const positive = (name, fallback, max) => {
    const n = Number(env[name] || fallback);
    if (!Number.isSafeInteger(n) || n < 1 || n > max)
      throw new Error(`Invalid ${name}`);
    return n;
  };
  const origin = env.APP_ORIGIN || (production ? "" : "http://127.0.0.1:3001");
  if (production && (!origin || !origin.startsWith("https://")))
    throw new Error("Production requires an HTTPS APP_ORIGIN");
  if (origin && new URL(origin).origin !== origin)
    throw new Error("APP_ORIGIN must be an exact origin");
  return {
    production,
    origin,
    demoEnabled: env.DEMO_MODE !== "false",
    sessionSeconds: positive("SESSION_TTL_SECONDS", 604800, 2592000),
    guestSeconds: positive("GUEST_TTL_SECONDS", 86400, 604800),
    poolMax: positive("DB_POOL_MAX", 5, 50),
    cookieName: production ? "__Host-soundwave" : "soundwave-session",
  };
}
