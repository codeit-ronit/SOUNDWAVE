import React from "react";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  cleanup,
} from "@testing-library/react";
import Creator from "./Creator";
import { api } from "./api";
let auth, state;
vi.mock("./AuthContext", () => ({ useAuth: () => auth }));
vi.mock("./api", () => ({
  api: { creator: vi.fn(), saveCreator: vi.fn(), deactivateCreator: vi.fn() },
}));
const active = () => ({
  displayName: "Creator Name",
  bio: "Private bio",
  status: "active",
});
beforeEach(() => {
  vi.resetAllMocks();
  auth = {
    user: { id: "owner-a", kind: "registered", displayName: "Listener" },
    csrfToken: "csrf-a",
  };
  state = { eligible: true, platformRole: "listener", creator: null };
  api.creator.mockImplementation(async () => state);
  api.saveCreator.mockImplementation(async (action, profile) => {
    state = { ...state, creator: { ...profile, status: "active" } };
    return state;
  });
  api.deactivateCreator.mockImplementation(async () => {
    state = { ...state, creator: { ...state.creator, status: "inactive" } };
    return state;
  });
});
afterEach(cleanup);
it("shows guest ineligibility and signed-out/offline state without privileged controls", async () => {
  state.eligible = false;
  const view = render(<Creator />);
  await screen.findByText(/Demo guests cannot become creators/);
  expect(
    screen.queryByRole("button", { name: "Activate creator access" }),
  ).toBeNull();
  auth = { user: null };
  view.rerender(<Creator />);
  expect(
    screen.getByText(/Creator settings are unavailable offline/),
  ).toBeTruthy();
});
it("activates creator access with scoped profile input and explains its limited permissions", async () => {
  render(<Creator />);
  await screen.findByLabelText("Creator display name");
  fireEvent.change(screen.getByLabelText("Creator display name"), {
    target: { value: "Creator Name" },
  });
  fireEvent.change(screen.getByLabelText("Creator bio"), {
    target: { value: "Private bio" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Activate creator access" }),
  );
  await screen.findByText("Status: active");
  expect(api.saveCreator).toHaveBeenCalledWith(
    "activate",
    { displayName: "Creator Name", bio: "Private bio" },
    expect.any(AbortSignal),
    expect.objectContaining({ user: { id: "owner-a" }, csrfToken: "csrf-a" }),
  );
  expect(screen.getByText(/This grants no admin privileges/)).toBeTruthy();
});
it("edits the current creator profile and displays successful persistence", async () => {
  state.creator = active();
  render(<Creator />);
  await screen.findByLabelText("Creator bio");
  fireEvent.change(screen.getByLabelText("Creator bio"), {
    target: { value: "New bio" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save creator profile" }));
  await screen.findByText("Creator profile saved.");
  expect(api.saveCreator.mock.calls[0][0]).toBe("edit");
  expect(screen.getByLabelText("Creator bio").value).toBe("New bio");
});
it("confirms deactivation and reactivates without deleting profile data", async () => {
  state.creator = active();
  render(<Creator />);
  await screen.findByText("Status: active");
  fireEvent.click(screen.getByText("Deactivate creator access"));
  fireEvent.click(screen.getByText("Cancel deactivation"));
  expect(api.deactivateCreator).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Deactivate creator access"));
  fireEvent.click(screen.getByText("Confirm deactivation"));
  await screen.findByText("Status: inactive");
  expect(screen.getByLabelText("Creator bio").value).toBe("Private bio");
  expect(screen.getByLabelText("Creator bio").disabled).toBe(true);
  fireEvent.click(screen.getByText("Reactivate creator access"));
  await screen.findByText("Status: active");
});
it("shows suspension as read-only and refreshes operator changes", async () => {
  state.creator = { ...active(), status: "suspended" };
  render(<Creator />);
  await screen.findByText("Status: suspended");
  expect(screen.getByLabelText("Creator bio").disabled).toBe(true);
  expect(screen.queryByText("Activate creator access")).toBeNull();
  expect(screen.queryByText("Save creator profile")).toBeNull();
  state = { ...state, creator: active() };
  fireEvent.click(screen.getByText("Refresh creator status"));
  await screen.findByText("Status: active");
});
it("recovers from read and mutation errors without claiming success", async () => {
  api.creator.mockRejectedValueOnce(Error("Temporary read failure"));
  render(<Creator />);
  await screen.findByText("Temporary read failure");
  fireEvent.click(screen.getByText("Try again"));
  await screen.findByLabelText("Creator display name");
  api.saveCreator.mockRejectedValueOnce(Error("Invalid creator bio"));
  fireEvent.click(screen.getByText("Activate creator access"));
  await screen.findByText("Invalid creator bio");
  expect(screen.queryByText("Status: active")).toBeNull();
  fireEvent.click(screen.getByText("Activate creator access"));
  await screen.findByText("Status: active");
});
it("aborts a delayed creator read and discards its response when accounts switch", async () => {
  let finish;
  api.creator.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const view = render(<Creator />);
  await waitFor(() => expect(api.creator).toHaveBeenCalledOnce());
  const signal = api.creator.mock.calls[0][0];
  auth = {
    user: { id: "owner-b", displayName: "Other listener" },
    csrfToken: "csrf-b",
  };
  view.rerender(<Creator />);
  await screen.findByText("Status: not activated");
  await act(() =>
    finish({ eligible: true, platformRole: "admin", creator: active() }),
  );
  expect(signal.aborted).toBe(true);
  expect(screen.getByLabelText("Creator display name").value).toBe(
    "Other listener",
  );
  expect(screen.queryByText("Account role: admin")).toBeNull();
});
it("aborts a pending creator mutation and cannot apply success to the next account", async () => {
  let finish;
  api.saveCreator.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const view = render(<Creator />);
  await screen.findByText("Activate creator access");
  fireEvent.click(screen.getByText("Activate creator access"));
  await waitFor(() => expect(api.saveCreator).toHaveBeenCalledOnce());
  const signal = api.saveCreator.mock.calls[0][2];
  auth = {
    user: { id: "owner-b", displayName: "Other listener" },
    csrfToken: "csrf-b",
  };
  view.rerender(<Creator />);
  await screen.findByText("Status: not activated");
  await act(() =>
    finish({ eligible: true, platformRole: "listener", creator: active() }),
  );
  expect(signal.aborted).toBe(true);
  expect(screen.queryByText("Status: active")).toBeNull();
  expect(screen.queryByText(/Creator access active\./)).toBeNull();
});
