// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Dev-only visual harness for the PWA install/update affordances. NOT part of
// the production build (only index.html is a build input). Served by the Vite
// dev server at /dev/pwa-preview.html so layout can be screenshotted in
// isolation — no API, auth, or service worker required:
//
//   pnpm --filter @gctp/web dev          # serve
//   node apps/web/scripts/shoot-pwa-preview.mjs   # screenshot mobile + desktop
//
// The header markup mirrors App.tsx's header (same classNames) so the real CSS
// — including the mobile/desktop responsive split — is exercised. Keep it in
// sync with App.tsx when the header structure changes.

import { StrictMode, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { Download, Menu, Route, Wrench } from "lucide-react";
import { UpdateToast } from "../src/features/shell/pwa-update-toast.js";
import "../src/styles.css";

function Preview(): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(true);
  const [showUpdate, setShowUpdate] = useState(true);

  return (
    <div className="app">
      <div className="app-top">
        <header className="app-header">
          <div className="app-header__title">
            <h1>gc-tour-planner</h1>
            <p>
              Plan closed-loop geocaching tours from filtered cache clusters.
            </p>
          </div>

          {/* Desktop actions cluster — hidden < 768px by the real media query. */}
          <div className="app-header__actions">
            <button type="button" className="app-header__tools">
              <Download size={16} aria-hidden="true" />
              <span className="app-header__tools-label">Install</span>
            </button>
            <button type="button" className="app-header__tools">
              <Wrench size={16} aria-hidden="true" />
              <span className="app-header__tools-label">Admin</span>
            </button>
            <div className="app-header__user">
              <a className="app-header__tours">My tours</a>
              <a className="app-header__tours">Account</a>
              <span className="app-header__user-name">Dev User</span>
              <button type="button" className="app-header__logout">
                Sign out
              </button>
            </div>
          </div>

          {/* Always-visible quick action (mobile). */}
          <a className="app-header__tours-quick" aria-label="My tours">
            <Route size={20} aria-hidden="true" />
          </a>

          {/* Mobile hamburger + dropdown — shown only < 768px. */}
          <div className="app-header__menu-wrap">
            <button
              type="button"
              className="app-header__hamburger"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              aria-label="Menu"
            >
              <Menu size={20} aria-hidden="true" />
            </button>
            {menuOpen && (
              <div className="app-header__menu" role="menu">
                <button
                  type="button"
                  className="app-header__menu-item"
                  role="menuitem"
                >
                  <Download size={16} aria-hidden="true" /> Install app
                </button>
                <button
                  type="button"
                  className="app-header__menu-item"
                  role="menuitem"
                >
                  <Wrench size={16} aria-hidden="true" /> Admin tools
                </button>
                <a className="app-header__menu-item" role="menuitem">
                  Account
                </a>
                <button
                  type="button"
                  className="app-header__menu-item"
                  role="menuitem"
                >
                  About
                </button>
                <button
                  type="button"
                  className="app-header__menu-item"
                  role="menuitem"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>
      </div>

      {showUpdate && (
        <UpdateToast
          onReload={() => {}}
          onDismiss={() => setShowUpdate(false)}
        />
      )}
    </div>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element missing");
createRoot(rootEl).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
