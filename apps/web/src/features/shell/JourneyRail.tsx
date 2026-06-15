// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useRef, type JSX } from "react";
import { Check, Lock } from "lucide-react";
import { JOURNEY_LABELS, JOURNEY_STEPS, type JourneyStep } from "./journey.js";

export interface JourneyRailProps {
  current: JourneyStep;
  /** Per-step enablement; a disabled step shows a lock + the `lockedReason`. */
  enabled: Record<JourneyStep, boolean>;
  /** Per-step "completed" flag → renders a ✓ instead of the step number. */
  done: Record<JourneyStep, boolean>;
  /** Tooltip shown on a locked step explaining how to unlock it. */
  lockedReason: Partial<Record<JourneyStep, string>>;
  /** Steps needing attention (e.g. clusters stale → re-discover) get a dot. */
  attention?: Partial<Record<JourneyStep, boolean>>;
  onSelect: (step: JourneyStep) => void;
}

/**
 * The persistent "where am I" progress indicator that floats over the map.
 *
 * An ordered stepper: each step is done (✓) / current (filled,
 * `aria-current="step"`) / locked (🔒 + reason) / available. ←/→ move between
 * enabled steps for keyboard users. Replaces the old `.sidebar-tabs` + the
 * three mobile FABs — one consistent affordance on every viewport.
 */
export function JourneyRail({
  current,
  enabled,
  done,
  lockedReason,
  attention,
  onSelect,
}: JourneyRailProps): JSX.Element {
  const btnRefs = useRef<Map<JourneyStep, HTMLButtonElement | null>>(new Map());

  const focusStep = (step: JourneyStep) => {
    btnRefs.current.get(step)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    // Walk to the next *enabled* step in the chosen direction.
    for (let i = idx + dir; i >= 0 && i < JOURNEY_STEPS.length; i += dir) {
      const step = JOURNEY_STEPS[i]!;
      if (enabled[step]) {
        focusStep(step);
        return;
      }
    }
  };

  return (
    <nav className="journey-rail" aria-label="Planning steps">
      <ol className="journey-rail__list">
        {JOURNEY_STEPS.map((step, idx) => {
          const isCurrent = step === current;
          const isEnabled = enabled[step];
          const isDone = done[step] && !isCurrent;
          const needsAttention = !!attention?.[step] && isEnabled;
          const reason = !isEnabled
            ? lockedReason[step]
            : needsAttention
              ? "Re-discover needed"
              : undefined;
          return (
            <li key={step} className="journey-rail__item">
              <button
                type="button"
                ref={(el) => {
                  btnRefs.current.set(step, el);
                }}
                className={[
                  "journey-chip",
                  isCurrent ? "journey-chip--current" : "",
                  isDone ? "journey-chip--done" : "",
                  !isEnabled ? "journey-chip--locked" : "",
                  needsAttention ? "journey-chip--attention" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-current={isCurrent ? "step" : undefined}
                // The visual label collapses to an icon on mobile; keep a
                // stable accessible name so the step is always announced.
                aria-label={JOURNEY_LABELS[step]}
                disabled={!isEnabled}
                title={reason}
                onClick={() => isEnabled && onSelect(step)}
                onKeyDown={(e) => onKeyDown(e, idx)}
              >
                <span className="journey-chip__marker" aria-hidden="true">
                  {!isEnabled ? (
                    <Lock size={15} aria-hidden="true" />
                  ) : isDone ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    idx + 1
                  )}
                </span>
                <span className="journey-chip__label">
                  {JOURNEY_LABELS[step]}
                </span>
                {needsAttention && (
                  <span className="journey-chip__dot" aria-hidden="true" />
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
