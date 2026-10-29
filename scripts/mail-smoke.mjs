// Test an already running LOCAL app + worker + SMTP catcher, including Docker.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
const base = process.argv[2],
  mailApi = process.argv[3];
if (
  !base ||
  !mailApi ||
  ![base, mailApi].every((v) =>
    ["localhost", "127.0.0.1"].includes(new URL(v).hostname),
  )
)
  throw Error(
    "Usage: node scripts/mail-smoke.mjs http://127.0.0.1:APP_PORT http://127.0.0.1:MAILPIT_PORT",
  );
let browser,
  checks = 0;
const pass = (text) => console.log(`PASS ${++checks}: ${text}`);
const email = "docker-" + randomUUID() + "@example.com";
async function emailLink(subject, purpose) {
  for (let n = 0; n < 100; n++) {
    const list = await fetch(mailApi + "/api/v1/messages").then((r) =>
      r.json(),
    );
    const row = list.messages?.find(
      (m) => m.Subject === subject && m.To?.some((to) => to.Address === email),
    );
    if (row) {
      const message = await fetch(mailApi + "/api/v1/message/" + row.ID).then(
        (r) => r.json(),
      );
      const link = message.Text.match(
        new RegExp("http://[^\\s]+#" + purpose + "=[a-f0-9]{64}"),
      )?.[0];
      if (link) {
        assert.equal(new URL(link).origin, base);
        return link;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("SMTP capture did not receive the expected message");
}
try {
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  let panel = page.getByRole("region", { name: "Your account" });
  await panel.getByLabel("Name", { exact: true }).fill("Container listener");
  await panel.getByLabel("Email", { exact: true }).fill(email);
  await panel
    .getByLabel("Password", { exact: true })
    .fill("a Docker test password!");
  await panel
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  const verify = await emailLink("Verify your SoundWave email", "verify_email");
  pass(
    "container API and worker deliver the registration email to local SMTP capture",
  );
  await page.goto(verify);
  await page
    .getByRole("button", { name: "Verify email", exact: true })
    .last()
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Email verified." })
    .waitFor();
  assert.equal(new URL(page.url()).hash, "");
  pass("container-served verification form consumes its token successfully");
  await page.goto(base + "/account");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page
    .getByRole("button", { name: "Send reset link", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "If this account exists" })
    .waitFor();
  const reset = await emailLink(
    "Reset your SoundWave password",
    "reset_password",
  );
  await page.goto(reset);
  await page
    .getByLabel("New password", { exact: true })
    .fill("a replacement Docker password!");
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Password reset." })
    .waitFor();
  pass("container recovery email and same-page reset navigation work together");
  await page
    .getByRole("link", { name: "Return to sign in", exact: true })
    .click();
  panel = page.getByRole("region", { name: "Your account" });
  await panel.getByLabel("Email", { exact: true }).fill(email);
  await panel
    .getByLabel("Password", { exact: true })
    .fill("a replacement Docker password!");
  await panel.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  pass(
    "new password signs in through the built app with no uncaught browser errors",
  );
  console.log(`${checks} local deployed email/browser checks passed.`);
} finally {
  if (browser) await browser.close();
}
