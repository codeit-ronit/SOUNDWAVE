import { isIP } from "node:net";
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
  const trustedProxies = (env.TRUSTED_PROXY_CIDRS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  for (const value of trustedProxies) {
    const [ip, bits, ...rest] = value.split("/");
    const version = isIP(ip);
    if (
      !version ||
      rest.length ||
      (bits !== undefined &&
        (!/^\d+$/.test(bits) ||
          Number(bits) < 1 ||
          Number(bits) > (version === 4 ? 32 : 128)))
    )
      throw Error("Invalid TRUSTED_PROXY_CIDRS");
  }
  if (env.REDIS_URL && !/^rediss?:\/\//.test(env.REDIS_URL))
    throw Error("Invalid REDIS_URL");
  const emailMode = env.EMAIL_MODE || "disabled";
  if (!["disabled", "smtp"].includes(emailMode))
    throw Error("EMAIL_MODE must be disabled or smtp");
  if (emailMode === "smtp") {
    if (!/^smtps?:\/\//.test(env.SMTP_URL || ""))
      throw Error("SMTP_URL is required");
    if (!/^[a-f0-9]{64}$/i.test(env.EMAIL_ENCRYPTION_KEY || ""))
      throw Error("EMAIL_ENCRYPTION_KEY is required");
    if (production && !/^smtps:\/\//.test(env.SMTP_URL))
      throw Error(
        "Production email requires an smtps:// transport with verified TLS",
      );
  }
  return {
    production,
    trustedProxies,
    redisUrl: env.REDIS_URL || null,
    catalogCacheEnabled: env.CATALOG_CACHE === "true",
    redisPrefix: env.REDIS_PREFIX || "soundwave",
    emailMode,
    smtpUrl: env.SMTP_URL || null,
    mailFrom: env.MAIL_FROM || "SoundWave <noreply@soundwave.local>",
    mailKey: env.EMAIL_ENCRYPTION_KEY || null,
    origin,
    demoEnabled: env.DEMO_MODE !== "false",
    sessionSeconds: positive("SESSION_TTL_SECONDS", 604800, 2592000),
    guestSeconds: positive("GUEST_TTL_SECONDS", 86400, 604800),
    poolMax: positive("DB_POOL_MAX", 5, 50),
    cookieName: production ? "__Host-soundwave" : "soundwave-session",
  };
}
