// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";

// Stub the router so the page can render without a full RouterProvider: we only
// need `useNavigate` (asserted) and a `Link` that renders an anchor.
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({
    to,
    children,
  }: {
    to: string;
    children: ReactNode;
  }): JSX.Element => <a href={to}>{children}</a>,
}));

// Import after the mock so the page picks up the stubbed router. The real `api`
// layer runs against a mocked `fetch`, so ApiError / zod parsing stay genuine.
const { AuthProvider, useAuth } = await import("./AuthProvider.js");
const { LoginPage } = await import("./LoginPage.js");

const USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "user@example.com",
  displayName: "Tester",
  isAdmin: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Surfaces the auth status so the test can wait for the initial probe to settle. */
function StatusProbe(): JSX.Element {
  const { status } = useAuth();
  return <div data-testid="auth-status">{status}</div>;
}

function renderLogin() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <StatusProbe />
        <LoginPage />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** Wait for the `GET /auth/me` probe to resolve before interacting. */
async function waitForAnonymous(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId("auth-status").textContent).toBe(
      "unauthenticated",
    ),
  );
}

describe("LoginPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    navigate.mockClear();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("logs in and redirects home on success", async () => {
    // First call: AuthProvider's /auth/me probe → anonymous. Then /auth/login → user.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: "no" }, 401))
      .mockResolvedValueOnce(jsonResponse(USER));

    renderLogin();
    await waitForAnonymous();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: USER.email },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "hunter2pass" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));

    // The login request carried the typed credentials to the right endpoint.
    const loginCall = fetchMock.mock.calls.find(
      ([url]) => url === "/api/auth/login",
    );
    expect(loginCall).toBeDefined();
    expect(JSON.parse(loginCall![1].body as string)).toEqual({
      email: USER.email,
      password: "hunter2pass",
    });
  });

  it("shows a generic error on bad credentials and does not redirect", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: "no" }, 401)) // /auth/me
      .mockResolvedValueOnce(jsonResponse({ message: "bad" }, 401)); // /auth/login

    renderLogin();
    await waitForAnonymous();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: USER.email },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrongpass1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await screen.findByText("Invalid email or password.");
    expect(navigate).not.toHaveBeenCalled();
  });
});
