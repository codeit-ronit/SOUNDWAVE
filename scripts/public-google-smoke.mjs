// Read-only provider UI check. Never enters Google credentials or fakes Google identity.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
const base = "https://soundwave-codeit-ronit.vercel.app";
const result = {
  date: new Date().toISOString(),
  checks: [],
  googleAccountCompletion:
    "Requires the account owner's manual Google session; this script does not authenticate a Google user.",
};
const pass = (s) => {
  result.checks.push(s);
  console.log(`PASS ${result.checks.length}: ${s}`);
};
let browser;
try {
  const privacy = await fetch(base + "/privacy.html");
  assert.equal(privacy.status, 200);
  assert.match(await privacy.text(), /Privacy and data use/);
  pass("public privacy page is available without authentication");
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined),
  });
  const context = await browser.newContext(),
    page = await context.newPage();
  page.setDefaultTimeout(45000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/?signin=1");
  const iframe = page.frameLocator(
    'iframe[title="Sign in with Google Button"]',
  );
  await iframe.getByRole("button").first().waitFor();
  const config = await page.evaluate(() =>
    fetch("/api/auth/session").then((r) => r.json()),
  );
  assert.ok(config.googleClientId?.endsWith(".apps.googleusercontent.com"));
  pass(
    "sign-in renders the real Google Identity Services button with the configured client",
  );
  await page
    .getByRole("button", { name: "Create a new account", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Create account", exact: true })
    .waitFor();
  await iframe.getByRole("button").first().waitFor();
  pass("sign-up also offers the same real Google button");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  pass(
    "the Google account panel fits a mobile viewport with no uncaught page errors",
  );
  const popupPromise = context
    .waitForEvent("page", { timeout: 15000 })
    .catch(() => null);
  await iframe.getByRole("button").first().click();
  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    const u = new URL(popup.url());
    result.googleChooser = { host: u.hostname, path: u.pathname };
    assert.equal(u.hostname, "accounts.google.com");
    const text = await popup
      .locator("body")
      .innerText()
      .catch(() => "");
    assert.doesNotMatch(
      text,
      /origin_mismatch|invalid_client|Error 400|Authorization Error/i,
    );
    pass(
      "Google opens its actual account-selection/sign-in page without an origin/client configuration error",
    );
  } else {
    result.googleChooser = {
      mode: "FedCM/browser-managed",
      note: "Native browser chooser is outside DOM automation; manual completion still required.",
    };
    console.log("NOT VERIFIED: native Google account chooser completion");
  }
  result.passed = result.checks.length;
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + "\n");
} finally {
  await browser?.close();
}
