import React, { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import GoogleSignIn from "./GoogleSignIn";
import { request } from "./api";
vi.mock("./api", () => ({ request: vi.fn() }));
let config, google;
beforeEach(() => {
  vi.clearAllMocks();
  config = null;
  google = {
    initialize: vi.fn((c) => {
      config = c;
    }),
    renderButton: vi.fn((node) => {
      const b = document.createElement("button");
      b.textContent = "Continue with Google";
      node.appendChild(b);
    }),
  };
  window.google = { accounts: { id: google } };
  request.mockResolvedValue({
    clientId: "test.apps.googleusercontent.com",
    nonce: "a".repeat(64),
  });
});
afterEach(() => {
  cleanup();
  delete window.google;
});
it("uses the official provider widget and one nonce request under StrictMode", async () => {
  const auth = { change: vi.fn().mockResolvedValue({}) },
    onSuccess = vi.fn();
  render(
    <StrictMode>
      <GoogleSignIn auth={auth} onSuccess={onSuccess} />
    </StrictMode>,
  );
  await screen.findByRole("button", { name: "Continue with Google" });
  expect(request).toHaveBeenCalledTimes(1);
  expect(config.nonce).toBe("a".repeat(64));
  expect(config.auto_select).toBe(false);
  await act(() => config.callback({ credential: "signed-token" }));
  expect(auth.change).toHaveBeenCalledWith("google", {
    credential: "signed-token",
  });
  expect(onSuccess).toHaveBeenCalledOnce();
});
it("shows failed authentication and refreshes the nonce for a retry", async () => {
  const auth = { change: vi.fn().mockRejectedValue(Error("Sign-in expired.")) };
  render(<GoogleSignIn auth={auth} onSuccess={vi.fn()} />);
  await screen.findByRole("button", { name: "Continue with Google" });
  await act(() => config.callback({ credential: "expired-token" }));
  await screen.findByText("Sign-in expired.");
  fireEvent.click(screen.getByRole("button", { name: "Try Google again" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  await screen.findByRole("button", { name: "Continue with Google" });
});
it("surfaces a challenge failure without pretending Google authenticated the user", async () => {
  request.mockRejectedValueOnce(Error("Sign-in unavailable."));
  const auth = { change: vi.fn() };
  render(<GoogleSignIn auth={auth} onSuccess={vi.fn()} />);
  await screen.findByText("Sign-in unavailable.");
  expect(auth.change).not.toHaveBeenCalled();
  expect(google.renderButton).not.toHaveBeenCalled();
});
it("reports a blocked Google script and permits a fresh retry", async () => {
  delete window.google;
  render(<GoogleSignIn auth={{ change: vi.fn() }} onSuccess={vi.fn()} />);
  const script = document.querySelector(
    'script[src="https://accounts.google.com/gsi/client"]',
  );
  fireEvent.error(script);
  await screen.findByText(
    "Google sign-in could not load. Check your connection and retry.",
  );
  window.google = { accounts: { id: google } };
  fireEvent.click(screen.getByRole("button", { name: "Try Google again" }));
  await screen.findByRole("button", { name: "Continue with Google" });
});
