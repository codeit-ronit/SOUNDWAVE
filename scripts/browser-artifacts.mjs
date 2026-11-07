import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

// Never save traces/HAR/HTML/storageState: they can contain session/recovery secrets.
export async function captureBrowserFailure(page, suite) {
  if (!process.env.BROWSER_ARTIFACT_DIR || !page || page.isClosed()) return;
  try {
    const dir = resolve(process.env.BROWSER_ARTIFACT_DIR);
    await mkdir(dir, { recursive: true });
    const name = suite.replace(/[^a-z0-9-]/gi, "-");
    const state = await page.evaluate(() => {
      const a = document.querySelector("audio");
      return {
        path: location.pathname,
        online: navigator.onLine,
        controlled: !!navigator.serviceWorker?.controller,
        audio: a
          ? {
              time: a.currentTime,
              paused: a.paused,
              ready: a.readyState,
              network: a.networkState,
              error: a.error?.code || null,
            }
          : null,
      };
    });
    await writeFile(
      join(dir, name + ".json"),
      JSON.stringify(state, null, 2) + "\n",
    );
    await page.screenshot({
      path: join(dir, name + ".png"),
      fullPage: true,
      mask: [
        page.locator(
          "input,textarea,[aria-label='Your account'],[aria-label='Profile settings']",
        ),
      ],
    });
  } catch {
    console.error("Browser diagnostic capture unavailable.");
  }
}
