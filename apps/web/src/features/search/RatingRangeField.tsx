// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { RatingRange } from "@gctp/shared/caches";

const STEPS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5] as const;

export interface RatingRangeFieldProps {
  label: string;
  value: RatingRange;
  onChange: (next: RatingRange) => void;
}

/**
 * Min/max picker for a D/T rating (1–5, half steps). Moving one bound past the
 * other drags the other along, so the range can never be inverted.
 */
export function RatingRangeField({
  label,
  value,
  onChange,
}: RatingRangeFieldProps) {
  const setMin = (min: number) =>
    onChange({ min, max: Math.max(min, value.max) });
  const setMax = (max: number) =>
    onChange({ min: Math.min(value.min, max), max });
  return (
    <div className="rating-range">
      <span className="rating-range__label">{label}</span>
      <select
        aria-label={`${label} minimum`}
        value={value.min}
        onChange={(e) => setMin(Number(e.target.value))}
      >
        {STEPS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <span aria-hidden="true">–</span>
      <select
        aria-label={`${label} maximum`}
        value={value.max}
        onChange={(e) => setMax(Number(e.target.value))}
      >
        {STEPS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </div>
  );
}
