// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  attributeById,
  descriptionHintByKey,
  TOOL_ATTRIBUTE_IDS,
} from "@gctp/shared/caches";
import { AttributeIcon } from "./AttributeIcon.js";

/**
 * Row of attribute chips for the cache popup (FR-SF4) + (FR-SF8).
 *
 * Two visually distinct rows:
 *   1. **Certain** chips — one per id in `attributeIds`. Tool ids
 *      get an orange tint; non-tool ids get a neutral gray.
 *   2. **Inferred** chips — one per key in `descriptionHints`.
 *      Italic + smaller font + lower opacity to signal "best guess
 *      from cache description, not authoritative." Tooltip on the
 *      heading explains the distinction.
 *
 * Both rows are hidden when their source is empty so the popup
 * doesn't grow vertical whitespace for caches with no chips.
 */
export function AttributeChips({
  attributeIds,
  descriptionHints,
}: {
  attributeIds: readonly number[];
  descriptionHints: readonly string[];
}): JSX.Element | null {
  // Filter to ids the curated lookup knows; unknown ids would
  // render as fallback chips that don't carry meaning to the user.
  const knownAttrs = attributeIds
    .map((id) => attributeById(id))
    .filter((a): a is NonNullable<typeof a> => a !== undefined);
  const knownHints = descriptionHints
    .map((k) => descriptionHintByKey(k))
    .filter((h): h is NonNullable<typeof h> => h !== undefined);

  if (knownAttrs.length === 0 && knownHints.length === 0) return null;

  return (
    <div className="cache-attr-chips">
      {knownAttrs.length > 0 && (
        <div className="cache-attr-chips__row">
          {knownAttrs.map((a) => {
            const isTool = TOOL_ATTRIBUTE_IDS.has(a.id);
            return (
              <span
                key={a.id}
                className={`chip${isTool ? " chip--tool" : ""}`}
                title={a.name}
              >
                <AttributeIcon iconKey={a.iconKey} title={a.name} />
                <span className="chip__label">{a.name}</span>
              </span>
            );
          })}
        </div>
      )}
      {knownHints.length > 0 && (
        <div
          className="cache-attr-chips__row cache-attr-chips__row--hint"
          title="Inferred from cache description — may be inaccurate"
        >
          {knownHints.map((h) => (
            <span key={h.key} className="chip chip--hint" title={h.label}>
              <AttributeIcon iconKey={h.iconKey} title={h.label} />
              <span className="chip__label">{h.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
