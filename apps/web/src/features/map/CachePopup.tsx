// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState } from "react";
import type { CacheType } from "@gctp/shared/caches";

export interface CachePopupProps {
  code: string;
  name: string;
  type: CacheType;
  difficulty: number | null;
  terrain: number | null;
  foundByMe: boolean;
  /** Toggle the find. Should return after the network call resolves. */
  onToggleFound: () => Promise<void>;
}

export function CachePopup({
  code,
  name,
  type,
  difficulty,
  terrain,
  foundByMe,
  onToggleFound,
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
