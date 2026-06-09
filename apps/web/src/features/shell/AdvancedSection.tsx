// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useId, useState, type JSX, type ReactNode } from "react";

/**
 * The single, uniform "Advanced" disclosure used across every step panel.
 *
 * Replaces the ad-hoc `<details class="advanced">` / `.planner-actions-advanced`
 * / `.cluster-metrics` disclosures that were scattered through the planner and
 * filter panels. One look, one behaviour, one place — so "advanced options"
 * read consistently no matter which step the user is on.
 *
 * Built on a button + region (not `<details>`) so it's fully controllable,
 * keyboard-accessible, and styleable without fighting the native marker.
 */
export function AdvancedSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <div className={`advanced-section${open ? " advanced-section--open" : ""}`}>
      <button
        type="button"
        className="advanced-section__summary"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="advanced-section__chevron" aria-hidden="true">
          ▸
        </span>
        {title}
      </button>
      {open && (
        <div id={bodyId} className="advanced-section__body">
          {children}
        </div>
      )}
    </div>
  );
}
