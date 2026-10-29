import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
export function mailCodec(key) {
  if (!/^[a-f0-9]{64}$/i.test(key || ""))
    throw Error("EMAIL_ENCRYPTION_KEY must be 32 random bytes encoded as hex");
  const secret = Buffer.from(key, "hex");
  return {
    encrypt(value) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", secret, iv);
      const bytes = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
      return {
        version: 1,
        iv: iv.toString("hex"),
        tag: cipher.getAuthTag().toString("hex"),
        data: bytes.toString("base64"),
      };
    },
    decrypt(value) {
      if (value.version !== 1)
        throw Error("Unsupported mail encryption version");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        secret,
        Buffer.from(value.iv, "hex"),
      );
      decipher.setAuthTag(Buffer.from(value.tag, "hex"));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(value.data, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      );
    },
  };
}
export function emailTransport(config) {
  if (config.emailMode === "disabled") return null;
  const codec = mailCodec(config.mailKey);
  const url = new URL(config.smtpUrl);
  const smtp = nodemailer.createTransport({
    host: url.hostname,
    port: Number(url.port || (url.protocol === "smtps:" ? 465 : 587)),
    secure: url.protocol === "smtps:",
    ...(url.username
      ? {
          auth: {
            user: decodeURIComponent(url.username),
            pass: decodeURIComponent(url.password),
          },
        }
      : {}),
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 8000,
    tls: { rejectUnauthorized: true },
    ignoreTLS: !config.production,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async send(id, payload) {
      const message = codec.decrypt(payload);
      if (new Date(message.expiresAt).getTime() <= Date.now()) return; // Do not deliver expired reset links on late retries.
      await smtp.sendMail({
        from: config.mailFrom,
        to: message.to,
        subject: message.subject,
        text: message.text,
        messageId: `<soundwave-${id}@${new URL(config.origin).hostname}>`,
      });
    },
    close: () => smtp.close(),
  };
}
