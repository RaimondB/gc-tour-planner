// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useLocalStorageState } from "../../lib/persistent-state.js";

type Snap = "closed" | "peek" | "half" | "full";
const SNAPS: readonly Snap[] = ["closed", "peek", "half", "full"];
/** Sheet height as a fraction of the viewport at the larger snaps. "closed"
 *  (slim grab bar) and "peek" (grab bar + the step's primary CTA, measured)
 *  are sized from content, not the viewport. */
const SNAP_FRACTION: Record<"half" | "full", number> = {
  half: 0.6,
  full: 0.94,
};
/** Height of the slim grab bar left on screen when the sheet is "closed". */
const CLOSED_BAR_PX = 46;
/** Pointer travel (px) past which a press is treated as a drag, not a tap. */
const DRAG_THRESHOLD = 6;

const MOBILE_QUERY = "(max-width: 768px)";

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

function useViewportHeight(): number {
  const [h, setH] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight : 800,
  );
  useEffect(() => {
    const onResize = () => setH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return h;
}

export interface CommandPanelProps {
  /** Step title shown in the panel header / sheet grab bar. */
  title: string;
  /**
   * Identifier for the active phase. When it changes, the sheet resets to its
   * default snap so each phase starts from a consistent drawer position.
   */
  stepKey?: string;
  /**
   * Always-visible primary action(s) for the current step. On mobile this stays
   * reachable at the "peek" snap; on desktop it sits at the top of the dock.
   */
  peek?: ReactNode;
  /** Full step controls — scrollable below the peek area. */
  children: ReactNode;
  /**
   * Reports the panel's bottom obstruction in CSS px (mobile sheet height; 0 on
   * desktop, where the dock is a separate column and never covers the map). The
   * map-fit logic uses this so framing isn't hidden behind the sheet.
   */
  onInsetChange?: (px: number) => void;
}

/**
 * Adaptive container for the active journey step.
 *
 *   - Desktop (≥768px): a fixed right-hand dock.
 *   - Mobile (<768px): a draggable bottom sheet with four snap points
 *     (closed / peek / half / full). "closed" slides the sheet off-screen,
 *     leaving only a slim grab bar so the map is fully usable; tap the bar (or
 *     drag up) to bring it back. Dragging is captured on the whole grab bar
 *     (not a tiny handle) so it reacts reliably; a tap toggles open/closed.
 */
export function CommandPanel({
  title,
  stepKey,
  peek,
  children,
  onInsetChange,
}: CommandPanelProps): JSX.Element {
  const isMobile = useIsMobile();
  const vh = useViewportHeight();
  const [snap, setSnap] = useLocalStorageState<Snap>("ui:sheet-snap", "peek");

  // Reset the sheet to its default (actions) stop on every phase change so each
  // phase starts from a consistent drawer position. The first mount is skipped
  // so a reload restores the persisted snap for the current phase.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setSnap("peek");
  }, [stepKey, setSnap]);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<{
    startY: number;
    startH: number;
    moved: boolean;
  } | null>(null);

  // The "peek" snap fits the grab bar + the step's primary CTA exactly (so the
  // main-flow button — Find / Discover / Plan — is visible without the settings
  // body). Measured from content; updates when the step's CTA changes.
  const gripRef = useRef<HTMLDivElement | null>(null);
  const peekRef = useRef<HTMLDivElement | null>(null);
  const [peekHeight, setPeekHeight] = useState(120);
  useEffect(() => {
    if (!isMobile) return;
    const measure = () => {
      const g = gripRef.current?.offsetHeight ?? CLOSED_BAR_PX;
      const p = peekRef.current?.offsetHeight ?? 0;
      setPeekHeight(g + p + 8);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (gripRef.current) ro.observe(gripRef.current);
    if (peekRef.current) ro.observe(peekRef.current);
    return () => ro.disconnect();
  }, [isMobile, peek]);

  const heightFor = useCallback(
    (s: Snap) => {
      if (s === "closed") return CLOSED_BAR_PX;
      if (s === "peek") return peekHeight;
      return SNAP_FRACTION[s] * vh;
    },
    [vh, peekHeight],
  );

  // Report the resting bottom obstruction (not during a drag) so the map-fit
  // logic can keep framed content above the sheet.
  useEffect(() => {
    onInsetChange?.(isMobile ? heightFor(snap) : 0);
  }, [isMobile, snap, vh, heightFor, onInsetChange]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!isMobile) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      startY: e.clientY,
      startH: dragHeight ?? heightFor(snap),
      moved: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    const dy = drag.current.startY - e.clientY; // up = grow
    if (Math.abs(dy) > DRAG_THRESHOLD) drag.current.moved = true;
    const next = drag.current.startH + dy;
    setDragHeight(Math.max(CLOSED_BAR_PX, Math.min(heightFor("full"), next)));
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const moved = drag.current.moved;
    const h = dragHeight ?? heightFor(snap);
    drag.current = null;
    setDragHeight(null);
    if (!moved) {
      // Tap toggles between the map (closed) and the actions stop (peek =
      // grab bar + the main-flow button). Drag for half/full.
      setSnap(snap === "closed" ? "peek" : "closed");
      return;
    }
    // Snap to whichever target height is closest to where the user let go.
    let nearest: Snap = "peek";
    let best = Infinity;
    for (const s of SNAPS) {
      const d = Math.abs(heightFor(s) - h);
      if (d < best) {
        best = d;
        nearest = s;
      }
    }
    setSnap(nearest);
  };

  const cycleUp = () => {
    const idx = SNAPS.indexOf(snap);
    setSnap(SNAPS[Math.min(idx + 1, SNAPS.length - 1)]!);
  };

  // Follow the finger 1:1 while dragging (no height transition); animate only
  // when settling to a snap.
  const style = isMobile
    ? dragHeight !== null
      ? { height: `${dragHeight}px`, transition: "none" }
      : { height: `${heightFor(snap)}px` }
    : undefined;

  return (
    <aside
      className="command-panel"
      data-snap={isMobile ? snap : undefined}
      style={style}
      role={isMobile ? "dialog" : undefined}
      aria-label={title}
    >
      <div
        ref={gripRef}
        className="command-panel__grip"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="command-panel__handle" aria-hidden="true" />
        {/* When closed, the grab bar doubles as a labelled reopen affordance. */}
        <span className="command-panel__grip-label">{title}</span>
        <button
          type="button"
          className="command-panel__grip-toggle"
          aria-label={snap === "closed" ? "Open panel" : "Expand panel"}
          onClick={() => (snap === "full" ? setSnap("closed") : cycleUp())}
        >
          {snap === "full" ? "▾" : "▴"}
        </button>
      </div>
      <header className="command-panel__header">
        <h2 className="command-panel__title">{title}</h2>
      </header>
      {peek && (
        <div ref={peekRef} className="command-panel__peek">
          {peek}
        </div>
      )}
      <div className="command-panel__body">{children}</div>
    </aside>
  );
}
