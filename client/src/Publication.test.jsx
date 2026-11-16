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
import Publication, { Moderation } from "./Publication";
import { api } from "./api";
let auth;
vi.mock("./api", () => ({
  api: {
    publication: vi.fn(),
    publicationAction: vi.fn(),
    moderation: vi.fn(),
    moderate: vi.fn(),
  },
}));
vi.mock("./AuthContext", () => ({ useAuth: () => auth }));
const scope = { user: { id: "owner" }, csrfToken: "csrf" },
  base = { publication: null, termsVersion: "creator-rights-v1", audit: [] };
beforeEach(() => {
  vi.clearAllMocks();
  auth = { ...scope };
  api.publication.mockResolvedValue(base);
});
afterEach(cleanup);
it("requires explicit rights declaration and sends only revision-scoped publication fields", async () => {
  api.publicationAction.mockResolvedValue({
    ...base,
    publication: { state: "submitted", revision: 1 },
  });
  render(<Publication id={900000000} scope={scope} />);
  const submit = await screen.findByRole("button", {
    name: "Submit for review",
  });
  expect(submit.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(submit);
  await waitFor(() => expect(api.publicationAction).toHaveBeenCalledOnce());
  expect(api.publicationAction.mock.calls[0][2]).toEqual({
    expectedRevision: 0,
    requestId: expect.any(String),
    attest: true,
    termsVersion: "creator-rights-v1",
  });
  await screen.findByText("submitted");
  expect(
    screen.getByText(/Previously downloaded or buffered copies/),
  ).toBeTruthy();
});
it("keeps uncertain mutation identity for safe retry and exposes recoverable conflicts", async () => {
  api.publicationAction
    .mockRejectedValueOnce(new Error("Connection lost"))
    .mockResolvedValueOnce({
      ...base,
      publication: { state: "submitted", revision: 1 },
    });
  render(<Publication id={900000000} scope={scope} />);
  await screen.findByRole("button", { name: "Submit for review" });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Retry same publication request",
    }),
  );
  await waitFor(() => expect(api.publicationAction).toHaveBeenCalledTimes(2));
  expect(api.publicationAction.mock.calls[0][2]).toEqual(
    api.publicationAction.mock.calls[1][2],
  );
});
it("retires another account’s pending moderation response", async () => {
  let finish;
  api.moderation
    .mockImplementationOnce(() => new Promise((r) => (finish = r)))
    .mockResolvedValue({ submissions: [] });
  const view = render(<Moderation />);
  auth = { user: { id: "other" }, csrfToken: "other" };
  view.rerender(<Moderation />);
  await screen.findByText("No pending submissions.");
  await act(async () =>
    finish({
      submissions: [{ storyId: 1, title: "Private previous account" }],
    }),
  );
  expect(screen.queryByText(/Private previous account/)).toBeNull();
});
it("moderation uses exact revision and controlled decisions, without publishing implicitly", async () => {
  api.moderation
    .mockResolvedValueOnce({
      submissions: [{ storyId: 900000000, title: "Review me" }],
    })
    .mockResolvedValueOnce({
      publication: { state: "submitted", revision: 7 },
      story: { title: "Review me" },
      current: true,
      chapters: [],
      audit: [],
    });
  api.moderate.mockResolvedValue({
    publication: { state: "approved", revision: 8 },
    audit: [],
  });
  render(<Moderation />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Review Review me" }),
  );
  fireEvent.change(await screen.findByLabelText("Decision note"), {
    target: { value: "Reviewed rights declaration and media." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Approve submission" }));
  await waitFor(() => expect(api.moderate).toHaveBeenCalledOnce());
  expect(api.moderate.mock.calls[0][2]).toMatchObject({
    expectedRevision: 7,
    code: "approved",
  });
  expect(api.publicationAction).not.toHaveBeenCalled();
  await screen.findByRole("heading", { name: "Review me", exact: true });
});
