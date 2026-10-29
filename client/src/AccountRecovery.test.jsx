import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import AccountRecovery from "./AccountRecovery";
import { request } from "./api";
vi.mock("./api", () => ({ request: vi.fn() }));
const token = "a".repeat(64);
beforeEach(() => {
  vi.clearAllMocks();
  history.replaceState(null, "", "/account");
});
afterEach(cleanup);
it("exchanges a verification fragment over POST and removes it from browser history", async () => {
  history.replaceState(null, "", "/account#verify_email=" + token);
  request.mockResolvedValue({ message: "Email verified." });
  render(
    <BrowserRouter>
      <AccountRecovery />
    </BrowserRouter>,
  );
  expect(location.hash).toBe("");
  expect(history.state?.idx).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Verify email" }));
  await screen.findByText("Email verified.");
  expect(request).toHaveBeenCalledWith("/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
});
it("opens a new reset link while the recovery page is already mounted", async () => {
  render(
    <BrowserRouter>
      <AccountRecovery />
    </BrowserRouter>,
  );
  expect(screen.getByLabelText("Email")).toBeTruthy();
  window.location.hash = "reset_password=" + token;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await screen.findByLabelText("New password");
  expect(location.hash).toBe("");
  expect(screen.queryByLabelText("Email")).toBe(null);
});
it("shows generic recovery feedback after a valid email submission", async () => {
  request.mockResolvedValue({
    message: "If this account exists, a reset link will be sent.",
  });
  render(
    <BrowserRouter>
      <AccountRecovery />
    </BrowserRouter>,
  );
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "listener@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
  await screen.findByRole("status");
  expect(request).toHaveBeenCalledWith("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email: "listener@example.com" }),
  });
});
it("shows expired-link errors without treating them as success", async () => {
  history.replaceState(null, "", "/account#verify_email=" + token);
  request.mockRejectedValue(Error("Link expired."));
  render(
    <BrowserRouter>
      <AccountRecovery />
    </BrowserRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Verify email" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Link expired."),
  );
  expect(screen.queryByText("Email verified.")).toBe(null);
});
