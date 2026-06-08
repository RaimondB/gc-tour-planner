// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState, type FormEvent, type JSX } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { RegisterInput } from "@gctp/shared/auth";
import { useAuth } from "./AuthProvider.js";
import { registerErrorMessage } from "./auth-messages.js";
import { TurnstileWidget, TURNSTILE_SITE_KEY } from "./TurnstileWidget.js";

type FieldErrors = Partial<
  Record<"email" | "password" | "displayName", string>
>;

/** Public `/register` route — self-service signup (FR-P5), then redirect to `/`. */
export function RegisterPage(): JSX.Element {
  const { register, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Cloudflare Turnstile token (FR-P5). When captcha is configured the submit
  // button stays disabled until the challenge is solved.
  const captchaRequired = TURNSTILE_SITE_KEY !== null;
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  // Bumped to remount (and re-challenge) the widget after a failed submit —
  // Turnstile tokens are single-use, so a consumed one must be re-solved.
  const [captchaNonce, setCaptchaNonce] = useState(0);

  useEffect(() => {
    if (isAuthenticated) void navigate({ to: "/" });
  }, [isAuthenticated, navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    // Validate client-side against the same shared schema the server enforces
    // (FR-P5: ≥10 chars, reject common passwords) so policy feedback is instant.
    const parsed = RegisterInput.safeParse({ email, password, displayName });
    if (!parsed.success) {
      const fe = parsed.error.flatten().fieldErrors;
      setFieldErrors({
        email: fe.email?.[0],
        password: fe.password?.[0],
        displayName: fe.displayName?.[0],
      });
      return;
    }
    if (captchaRequired && !captchaToken) {
      setError("Please complete the captcha challenge.");
      return;
    }
    setFieldErrors({});
    setPending(true);
    try {
      await register(parsed.data, captchaToken ?? undefined);
      // Navigation handled by the effect once `isAuthenticated` flips true.
    } catch (err) {
      setError(registerErrorMessage(err));
      setPending(false);
      // The token was consumed by the failed attempt; force a fresh challenge.
      setCaptchaToken(null);
      setCaptchaNonce((n) => n + 1);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <h1 className="auth-card__title">Create account</h1>
        <p className="auth-card__subtitle">gc-tour-planner</p>

        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}

        <label className="auth-field">
          <span>Display name</span>
          <input
            type="text"
            name="displayName"
            autoComplete="nickname"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
          {fieldErrors.displayName && (
            <small className="auth-field__error">
              {fieldErrors.displayName}
            </small>
          )}
        </label>

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
          {fieldErrors.email && (
            <small className="auth-field__error">{fieldErrors.email}</small>
          )}
        </label>

        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {fieldErrors.password ? (
            <small className="auth-field__error">{fieldErrors.password}</small>
          ) : (
            <small className="auth-field__hint">
              At least 10 characters. Longer passphrases are stronger.
            </small>
          )}
        </label>

        {captchaRequired && TURNSTILE_SITE_KEY && (
          <TurnstileWidget
            key={captchaNonce}
            siteKey={TURNSTILE_SITE_KEY}
            onToken={setCaptchaToken}
          />
        )}

        <button
          type="submit"
          className="auth-submit"
          disabled={pending || (captchaRequired && !captchaToken)}
        >
          {pending ? "Creating account…" : "Create account"}
        </button>

        <a className="auth-oauth" href="/api/auth/google">
          Continue with Google
        </a>

        <p className="auth-switch">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
