// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { JSX } from "react";

/**
 * The gc-tour-planner brand mark: a four-quadrant "GCTP" monogram. Three
 * accent-orange cells plus a green "P" quadrant — a nod to the app's
 * parking-aware planning (and the original green parking favicon). Used in
 * both the public landing page and the post-login app header.
 */
export function Logo({ size = 30 }: { size?: number }): JSX.Element {
  return (
    <svg
      className="brand-logo"
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id="gctp-logo-clip">
          <rect x="1" y="1" width="38" height="38" rx="10" />
        </clipPath>
      </defs>
      <g clipPath="url(#gctp-logo-clip)">
        <rect x="1" y="1" width="19" height="19" fill="#d84315" />
        <rect x="20" y="1" width="19" height="19" fill="#bf360c" />
        <rect x="1" y="20" width="19" height="19" fill="#bf360c" />
        <rect x="20" y="20" width="19" height="19" fill="#16a34a" />
      </g>
      {/* white dividing cross */}
      <line x1="20" y1="2" x2="20" y2="38" stroke="#fff" strokeWidth="1.6" />
      <line x1="2" y1="20" x2="38" y2="20" stroke="#fff" strokeWidth="1.6" />
      {/* GCTP monogram */}
      <g
        fill="#fff"
        fontFamily="Inter, system-ui, sans-serif"
        fontWeight="700"
        fontSize="13"
        textAnchor="middle"
      >
        <text x="10.5" y="15.5">
          G
        </text>
        <text x="29.5" y="15.5">
          C
        </text>
        <text x="10.5" y="34.5">
          T
        </text>
        <text x="29.5" y="34.5">
          P
        </text>
      </g>
    </svg>
  );
}
