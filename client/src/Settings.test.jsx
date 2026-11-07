import React from "react";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import Settings from "./Settings";
import { api } from "./api";
let auth, prefs, profile;
vi.mock("./AuthContext", () => ({ useAuth: () => auth }));
vi.mock("./PreferencesContext", () => ({ usePreferences: () => prefs }));
vi.mock("./api", () => ({ api: { profile: vi.fn(), saveProfile: vi.fn() } }));
vi.mock("./components", () => ({
  Loading: ({ label }) => <p>{label}</p>,
  ErrorState: ({ message, retry }) => (
    <div role="alert">
      {message}
      <button onClick={retry}>Retry profile</button>
    </div>
  ),
}));
beforeEach(() => {
  vi.resetAllMocks();
  profile = {
    id: "owner-a",
    displayName: "Listener",
    email: "listener@example.com",
    emailVerified: true,
    googleLinked: true,
    kind: "registered",
  };
  auth = {
    user: { id: "owner-a" },
    csrfToken: "csrf-a",
    acceptProfile: vi.fn().mockReturnValue(true),
  };
  prefs = {
    settings: { playbackSpeed: 1, autoplayNext: true, defaultVolume: 0.8 },
    ready: true,
    loading: false,
    pending: 0,
    error: "",
    reload: vi.fn(),
    update: vi.fn().mockImplementation(async (patch) => {
      prefs.settings = { ...prefs.settings, ...patch };
      return prefs.settings;
    }),
  };
  api.profile.mockImplementation(async () => ({ profile }));
  api.saveProfile.mockImplementation(async (name) => {
    profile = { ...profile, displayName: name.trim() };
    return { profile };
  });
});
afterEach(cleanup);
it("shows immutable email/verification/Google metadata and updates the owner name", async () => {
  render(<Settings />);
  await screen.findByText("listener@example.com");
  expect(screen.getByText("Verified")).toBeTruthy();
  expect(screen.getByText("Linked to this account")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Email" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: "New name" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await screen.findByText("Profile saved.");
  expect(auth.acceptProfile).toHaveBeenCalledWith(
    expect.objectContaining({ displayName: "New name" }),
    "csrf-a",
  );
  expect(api.saveProfile).toHaveBeenCalledWith(
    "New name",
    expect.objectContaining({ user: { id: "owner-a" } }),
  );
});
it("keeps a rejected name editable and allows correction/retry", async () => {
  api.saveProfile.mockRejectedValueOnce(Error("Name is invalid"));
  render(<Settings />);
  await screen.findByLabelText("Display name");
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: " " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Display name").value).toBe(" ");
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: "Valid name" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await screen.findByText("Profile saved.");
  expect(screen.queryByRole("alert")).toBeNull();
});
it("saves typed playback preferences without any identity fields", async () => {
  render(<Settings />);
  await screen.findByLabelText("Display name");
  fireEvent.change(screen.getByLabelText("Default playback speed"), {
    target: { value: "1.5" },
  });
  fireEvent.click(screen.getByLabelText("Automatically play the next chapter"));
  fireEvent.change(screen.getByLabelText("Default volume"), {
    target: { value: "0.4" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save playback preferences" }),
  );
  await screen.findByText("Playback preferences saved.");
  expect(prefs.update).toHaveBeenCalledWith({
    playbackSpeed: 1.5,
    autoplayNext: false,
    defaultVolume: 0.4,
  });
});
it("discarding an old account response cannot rename the next account's UI", async () => {
  let finish;
  api.saveProfile.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const result = render(<Settings />);
  await screen.findByLabelText("Display name");
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(api.saveProfile).toHaveBeenCalledOnce());
  auth = { ...auth, user: { id: "owner-b" }, csrfToken: "csrf-b" };
  profile = {
    ...profile,
    id: "owner-b",
    displayName: "Second listener",
    email: "second@example.com",
  };
  result.rerender(<Settings />);
  await screen.findByText("second@example.com");
  await act(() =>
    finish({
      profile: { ...profile, id: "owner-a", displayName: "Old response" },
    }),
  );
  expect(auth.acceptProfile).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Display name").value).toBe("Second listener");
  expect(screen.queryByText("Profile saved.")).toBeNull();
});
it("exposes recoverable load errors and no private forms while signed out", async () => {
  api.profile.mockRejectedValueOnce(Error("Profile read failed"));
  const rendered = render(<Settings />);
  await screen.findByText("Profile read failed");
  fireEvent.click(screen.getByRole("button", { name: "Retry profile" }));
  await screen.findByLabelText("Display name");
  auth = { user: null, offline: true };
  rendered.rerender(<Settings />);
  expect(screen.queryByLabelText("Display name")).toBeNull();
  expect(
    screen.getByText(/Account settings are unavailable offline/),
  ).toBeTruthy();
});
