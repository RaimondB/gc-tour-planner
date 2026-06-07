// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState, type FormEvent, type JSX } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "./AuthProvider.js";
import { loginErrorMessage } from "./auth-messages.js";

/** Public `/login` route — establishes a session, then redirects to `/`. */
export function LoginPage(): JSX.Element {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Redirect away once authenticated — covers both a fresh login and landing
  // here with an existing session. The `/` route's beforeLoad guards the
  // reverse direction (anonymous → /login).
  useEffect(() => {
    if (isAuthenticated) void navigate({ to: "/" });
  }, [isAuthenticated, navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await login({ email, password });
      // Navigation handled by the effect once `isAuthenticated` flips true.
    } catch (err) {
      setError(loginErrorMessage(err));
      setPending(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <h1 className="auth-card__title">Sign in</h1>
        <p className="auth-card__subtitle">gc-tour-planner</p>

        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}

        <label className="auth-field">
          <span>Email</span>
          <input
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        <button type="submit" className="auth-submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>

        <a className="auth-oauth" href="/api/auth/google">
          Continue with Google
        </a>

        <p className="auth-switch">
          No account? <Link to="/register">Create one</Link>
        </p>
      </form>
    </div>
  );
}
