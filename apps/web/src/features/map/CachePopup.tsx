// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, type JSX } from "react";
import { classifyMulti } from "@gctp/shared/caches";
import type { CacheType } from "@gctp/shared/caches";
import { AttributeChips } from "../caches/AttributeChips.js";

export interface CachePopupProps {
  code: string;
  name: string;
  type: CacheType;
  difficulty: number | null;
  terrain: number | null;
  foundByMe: boolean;
  /** Toggle the find. Should return after the network call resolves. */
  onToggleFound: () => Promise<void>;
  /** Curated cache attribute ids (positive only) for chip rendering. */
  attributeIds?: readonly number[];
  /** FR-SF8 multilingual description-hint keys (e.g. "fishingRod"). */
  descriptionHints?: readonly string[];
  /** FR-SF1 count of `stages` waypoints. 0 for non-multis. */
  stageCount?: number;
  /**
   * True when the plotted location is a user-supplied solved/corrected
   * coordinate (Mystery solution or Multi final). Shows a pill + the
   * "remove solved coordinates" action.
   */
  solved?: boolean;
  /**
   * Remove the solved coordinate (revert to the posted coord). Provided only
   * when the cache is solved. Should resolve after the network call.
   */
  onClearSolved?: () => Promise<void>;
  /**
   * True while the per-cache detail (difficulty/terrain/attributes/hints) is
   * still loading from `GET /caches/:id` — the lean list doesn't carry them.
   * The header (code/name/type/found) renders immediately regardless.
   */
  loadingDetail?: boolean;
  /**
   * False when offline — mark-found / clear-solved write to the server, so the
   * buttons disable and explain why. Defaults to true.
   */
  online?: boolean;
}

export function CachePopup({
  code,
  name,
  type,
  difficulty,
  terrain,
  foundByMe,
  onToggleFound,
  attributeIds = [],
  descriptionHints = [],
  stageCount = 0,
  solved = false,
  onClearSolved,
  loadingDetail = false,
  online = true,
}: CachePopupProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [clearingSolved, setClearingSolved] = useState(false);

  const handleClick = async () => {
    setBusy(true);
    try {
      await onToggleFound();
    } finally {
      setBusy(false);
    }
  };

  const handleClearSolved = async () => {
    if (!onClearSolved) return;
    setClearingSolved(true);
    try {
      await onClearSolved();
    } finally {
      setClearingSolved(false);
    }
  };

  // Multi sub-type label (FR-SF2). 0 stages → field-puzzle multi
  // (owner expects you to derive the next coord on-site); 1-2 →
  // mini; 3+ → full.
  let multiLabel: string | null = null;
  if (type === "Multi") {
    const klass = classifyMulti(stageCount);
    if (klass === "field-puzzle") {
      multiLabel = "Field-puzzle multi (no stage waypoints)";
    } else if (klass === "mini") {
      multiLabel = `Mini-multi (${stageCount} stage${stageCount === 1 ? "" : "s"})`;
    } else {
      multiLabel = `Full multi (${stageCount} stages)`;
    }
  }

  return (
    <div className="cache-popup">
      <div className="cache-popup__title">
        <strong>{code}</strong> &middot; {type}
      </div>
      <div className="cache-popup__name">{name}</div>
      <div className="cache-popup__meta">
        D {loadingDetail ? "…" : (difficulty ?? "?")} / T{" "}
        {loadingDetail ? "…" : (terrain ?? "?")}
        {foundByMe && <span className="cache-popup__found-pill">Found</span>}
        {solved && <span className="cache-popup__found-pill">Solved</span>}
      </div>
      {solved && (
        <div className="cache-popup__meta cache-popup__meta--muted">
          Plotted at your solved coordinate.
        </div>
      )}
      {multiLabel && (
        <div className="cache-popup__meta cache-popup__meta--muted">
          {multiLabel}
        </div>
      )}
      {loadingDetail ? (
        <div className="cache-popup__meta cache-popup__meta--muted">
          Loading details…
        </div>
      ) : (
        <AttributeChips
          attributeIds={attributeIds}
          descriptionHints={descriptionHints}
        />
      )}
      {/* Full description, the official hint, logs etc. aren't stored locally
          (and redistributing Groundspeak descriptions is a licensing concern),
          so link out to the canonical cache page which has all of it. */}
      <a
        className="cache-popup__link"
        href={`https://coord.info/${code}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Full details on geocaching.com ↗
      </a>
      <button
        type="button"
        className={`cache-popup__btn${foundByMe ? " cache-popup__btn--unmark" : ""}`}
        onClick={handleClick}
        disabled={busy || !online}
        title={online ? undefined : "Marking found needs a connection."}
      >
        {busy ? "Saving…" : foundByMe ? "Unmark as found" : "Mark as found"}
      </button>
      {solved && onClearSolved && (
        <button
          type="button"
          className="cache-popup__btn cache-popup__btn--unmark"
          onClick={handleClearSolved}
          disabled={clearingSolved || !online}
          title={online ? undefined : "Editing coordinates needs a connection."}
        >
          {clearingSolved ? "Removing…" : "Remove solved coordinates"}
        </button>
      )}
      {!online && (
        <div className="cache-popup__meta cache-popup__meta--muted">
          Offline — found/solved edits are unavailable.
        </div>
      )}
    </div>
  );
}
