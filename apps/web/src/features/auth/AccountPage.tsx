// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, type FormEvent, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { Password } from "@gctp/shared/auth";
import { setPassword } from "../../lib/api.js";
import { useAuth } from "./AuthProvider.js";
import { setPasswordErrorMessage } from "./auth-messages.js";

/**
 * Protected `/account` route — lets the signed-in user set or change their
 * password. Setting one on a Google-only account enables a shared (e.g.
 * family) email + password login alongside Google sign-in.
 */
export function AccountPage(): JSX.Element {
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldError(null);
    setDone(false);

    // Client-side mirror of the server policy for instant feedback.
    const parsed = Password.safeParse(newPassword);
    if (!parsed.success) {
      setFieldError(
        parsed.error.issues[0]?.message ?? "Choose a stronger password.",
      );
      return;
    }
    if (newPassword !== confirm) {
      setFieldError("The two new passwords don't match.");
      return;
    }

    setPending(true);
    try {
      await setPassword({
        currentPassword: currentPassword || undefined,
        newPassword,
      });
      setDone(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
    } catch (err) {
      setError(setPasswordErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="account-page">
      <div className="account-page__top">
        <Link to="/" className="account-page__back">
          ← Back to planner
        </Link>
      </div>

      <h1 className="account-page__title">Account</h1>
      {user && (
        <p className="account-page__who">
          Signed in as <strong>{user.displayName}</strong> ({user.email})
        </p>
      )}

      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <h2 className="auth-card__title">Set a password</h2>
        <p className="auth-card__subtitle">
          Add or change an email + password login for this account — handy for
          sharing it (e.g. with family) alongside Google sign-in.
        </p>

        {done && (
          <p className="auth-success" role="status">
            Password updated.
          </p>
        )}
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}

        <label className="auth-field">
          <span>Current password</span>
          <input
            type="password"
            name="current-password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          <small className="auth-field__hint">
            Only needed if you've already set a password before.
          </small>
        </label>

        <label className="auth-field">
          <span>New password</span>
          <input
            type="password"
            name="new-password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
        </label>

        <label className="auth-field">
          <span>Confirm new password</span>
          <input
            type="password"
            name="confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          {fieldError && (
            <small className="auth-field__error">{fieldError}</small>
          )}
        </label>

        <button type="submit" className="auth-submit" disabled={pending}>
          {pending ? "Saving…" : "Save password"}
        </button>
      </form>
    </div>
  );
}
