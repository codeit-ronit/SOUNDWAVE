import React from "react";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import DraftAudio from "./DraftAudio";
import { api, uploadPrivateAudio } from "./api";
vi.mock("./api", () => ({
  api: {
    privateMediaStatus: vi.fn(),
    privateAsset: vi.fn(),
    reservePrivateMedia: vi.fn(),
    removePrivateMedia: vi.fn(),
  },
  uploadPrivateAudio: vi.fn(),
}));
const scope = { user: { id: "account-a" }, csrfToken: "csrf" },
  chapter = { id: 900000001, title: "Private chapter", revision: 1 };
const reserved = { id: "asset-a", revision: 1, status: "reserved" },
  validated = { ...reserved, revision: 4, status: "validated" };
let status;
beforeEach(() => {
  vi.clearAllMocks();
  status = {
    headRevision: 0,
    current: null,
    recent: [],
    usedBytes: 0,
    maxBytes: 10000,
    quotaBytes: 50000,
  };
  api.privateMediaStatus.mockImplementation(async () => status);
  api.reservePrivateMedia.mockResolvedValue({ asset: reserved });
  api.privateAsset.mockResolvedValue({ asset: reserved });
  api.removePrivateMedia.mockResolvedValue({
    asset: { ...reserved, status: "deleted" },
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function open() {
  const result = render(
    <DraftAudio storyId={900000000} chapter={chapter} scope={scope} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Manage audio for Private chapter" }),
  );
  await screen.findByText("Current audio: none");
  return result;
}
const file = () =>
  new File([new Uint8Array(100)], "voice.wav", { type: "audio/wav" });
const select = (f) =>
  fireEvent.change(screen.getByLabelText("Audio file for Private chapter"), {
    target: { files: [f] },
  });
it("loads lazily, scopes requests and rejects invalid/oversized/empty files locally", async () => {
  render(<DraftAudio storyId={900000000} chapter={chapter} scope={scope} />);
  expect(api.privateMediaStatus).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Manage audio for Private chapter" }),
  );
  await screen.findByText("Current audio: none");
  for (const f of [
    new File([], "empty.wav"),
    new File(["bad"], "bad.mp3"),
    new File([new Uint8Array(10001)], "big.wav"),
  ]) {
    select(f);
    expect(screen.getByRole("alert").textContent).toContain("nonempty WAV");
    expect(
      screen.getByRole("button", { name: "Upload private WAV" }).disabled,
    ).toBe(true);
  }
  expect(api.privateMediaStatus.mock.calls[0][3]).toEqual(scope);
});
it("reserves once, reports transfer progress and exposes only authenticated unpublished preview", async () => {
  await open();
  let resolve;
  uploadPrivateAudio.mockImplementation(
    (s, c, id, f, options) =>
      new Promise((r) => {
        resolve = r;
        options.onProgress(40);
      }),
  );
  select(file());
  fireEvent.click(screen.getByRole("button", { name: "Upload private WAV" }));
  await waitFor(() => expect(screen.getByRole("progressbar").value).toBe(40));
  expect(api.reservePrivateMedia.mock.calls[0][2]).toMatchObject({
    byteSize: 100,
    expectedChapterRevision: 1,
    expectedHeadRevision: 0,
  });
  status = { ...status, headRevision: 1, current: validated };
  await act(async () => resolve({ asset: validated }));
  await screen.findByText("Private audio validated. Still unpublished.");
  expect(document.querySelector("audio").getAttribute("preload")).toBe("none");
  expect(document.querySelector("audio").getAttribute("src")).toBe(
    "/api/creator/stories/900000000/chapters/900000001/media/asset-a/preview",
  );
});
it("an uncertain reservation retains the exact UUID/payload for retry", async () => {
  await open();
  api.reservePrivateMedia
    .mockRejectedValueOnce(Error("Connection lost"))
    .mockResolvedValueOnce({ asset: reserved });
  uploadPrivateAudio.mockResolvedValue({ asset: validated });
  select(file());
  fireEvent.click(screen.getByRole("button", { name: "Upload private WAV" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Audio file for Private chapter").disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry same upload" }));
  await screen.findByText("Private audio validated. Still unpublished.");
  expect(api.reservePrivateMedia.mock.calls[0][2]).toEqual(
    api.reservePrivateMedia.mock.calls[1][2],
  );
});
it("cancel aborts transfer and status refresh resolves failed uploads before another file is selected", async () => {
  await open();
  let signal;
  uploadPrivateAudio.mockImplementation((s, c, id, f, o) => {
    signal = o.signal;
    return new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(Error("cancelled"))),
    );
  });
  select(file());
  fireEvent.click(screen.getByRole("button", { name: "Upload private WAV" }));
  await screen.findByRole("button", { name: "Cancel upload" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
  await screen.findByText(
    "Upload cancelled. Refresh status to resolve any accepted bytes.",
  );
  expect(signal.aborted).toBe(true);
  api.privateAsset.mockResolvedValue({
    asset: { ...reserved, status: "failed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh media status" }));
  await screen.findByText("Upload status: failed");
  expect(screen.getByLabelText("Audio file for Private chapter").disabled).toBe(
    false,
  );
});
it("unmount retires a pending account-scoped response", async () => {
  let resolve;
  api.privateMediaStatus.mockImplementation(
    () => new Promise((r) => (resolve = r)),
  );
  const view = render(
    <DraftAudio storyId={900000000} chapter={chapter} scope={scope} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Manage audio for Private chapter" }),
  );
  const signal = api.privateMediaStatus.mock.calls[0][2];
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(status));
  expect(api.reservePrivateMedia).not.toHaveBeenCalled();
});
it("private audio deletion requires confirmation and the latest owned asset revision", async () => {
  status = { ...status, current: validated };
  render(<DraftAudio storyId={900000000} chapter={chapter} scope={scope} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Manage audio for Private chapter" }),
  );
  await screen.findByText("Current audio: validated");
  fireEvent.click(screen.getByRole("button", { name: "Delete private audio" }));
  expect(api.removePrivateMedia).not.toHaveBeenCalled();
  api.privateAsset.mockResolvedValue({ asset: validated });
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm remove private audio" }),
  );
  await screen.findByText(
    "Private audio removed. Cleanup may finish asynchronously.",
  );
  expect(api.removePrivateMedia.mock.calls[0].slice(0, 4)).toEqual([
    900000000,
    900000001,
    "asset-a",
    4,
  ]);
});

it("private preview keyboard controls keep native defaults without reaching global player shortcuts", async () => {
  status = { ...status, current: validated };
  render(<DraftAudio storyId={900000000} chapter={chapter} scope={scope} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Manage audio for Private chapter" }),
  );
  await screen.findByText("Current audio: validated");
  const key = vi.fn();
  window.addEventListener("keydown", key);
  try {
    const audio = document.querySelector("audio");
    expect(fireEvent.keyDown(audio, { key: " ", code: "Space" })).toBe(true);
    fireEvent.keyDown(audio, { key: "ArrowRight" });
    expect(key).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("keydown", key);
  }
});
