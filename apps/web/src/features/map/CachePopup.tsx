// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState } from "react";
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
}: CachePopupProps): JSX.Element {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    setBusy(true);
    try {
      await onToggleFound();
    } finally {
      setBusy(false);
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
        D {difficulty ?? "?"} / T {terrain ?? "?"}
        {foundByMe && <span className="cache-popup__found-pill">Found</span>}
      </div>
      {multiLabel && (
        <div className="cache-popup__meta cache-popup__meta--muted">
          {multiLabel}
        </div>
      )}
      <AttributeChips
        attributeIds={attributeIds}
        descriptionHints={descriptionHints}
      />
      <button
        type="button"
        className={`cache-popup__btn${foundByMe ? " cache-popup__btn--unmark" : ""}`}
        onClick={handleClick}
        disabled={busy}
      >
        {busy ? "Saving…" : foundByMe ? "Unmark as found" : "Mark as found"}
      </button>
    </div>
  );
}
