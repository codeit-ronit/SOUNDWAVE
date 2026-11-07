// Arm these before the UI action. Resolve only after a successful server ACK,
// never on the truthiness of a Promise returned from waitForFunction's predicate.
export function waitForProgressSave(page, predicate) {
  return page.waitForResponse(
    async (response) => {
      if (
        response.request().method() !== "PUT" ||
        !/^\/api\/progress\/\d+$/.test(new URL(response.url()).pathname) ||
        !response.ok()
      )
        return false;
      const data = await response.json();
      return predicate(data.progress);
    },
    { timeout: 10000 },
  );
}
export function waitForPlaybackEvent(page, type) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/analytics/events" &&
      response.ok() &&
      response.request().postDataJSON()?.type === type,
    { timeout: 10000 },
  );
}
