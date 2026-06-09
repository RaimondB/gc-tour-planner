// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { JSX } from "react";
import type {
  TestRouteResponse,
  WalkingGraphResponse,
} from "@gctp/shared/tours";
import type { SearchParams } from "../../lib/search-params.js";
import {
  ClusterLabPanel,
  DebugOverlaysPanel,
  type PlanSettings,
} from "../planning/PlannerSidebar.js";
import { AdminPrecomputePanel } from "../admin/AdminPrecomputePanel.js";

export interface AdminToolsPanelProps {
  open: boolean;
  onClose: () => void;
  search: SearchParams;
  settings: PlanSettings;
  showWalkingGraph: boolean;
  onShowWalkingGraphChange: (next: boolean) => void;
  walkingGraphStats: WalkingGraphResponse["stats"] | null;
  selectedCacheIds: ReadonlySet<number>;
  onSelectionChange: (next: ReadonlySet<number>) => void;
  testRoute: TestRouteResponse | null;
  onTestRouteChange: (next: TestRouteResponse | null) => void;
}

/**
 * Admin/debug surface — the precompute dashboard, the walking-graph overlay,
 * and the cluster lab (explain / test-OSRM / purge). All of these hit `/admin/*`
 * or are debug-only, so the whole surface (and the gear that opens it) is
 * gated on `user.isAdmin` by the caller. Non-admins never see any of it.
 */
export function AdminToolsPanel({
  open,
  onClose,
  search,
  settings,
  showWalkingGraph,
  onShowWalkingGraphChange,
  walkingGraphStats,
  selectedCacheIds,
  onSelectionChange,
  testRoute,
  onTestRouteChange,
}: AdminToolsPanelProps): JSX.Element | null {
  if (!open) return null;
  return (
    <div
      className="tools-drawer-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <aside
        id="tools-drawer"
        className="tools-drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Admin tools"
      >
        <header className="tools-drawer__header">
          <h2>Admin tools</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close admin tools"
          >
            ✕
          </button>
        </header>
        <div className="tools-drawer__body">
          <AdminPrecomputePanel />
          <DebugOverlaysPanel
            search={search}
            settings={settings}
            showWalkingGraph={showWalkingGraph}
            onShowWalkingGraphChange={onShowWalkingGraphChange}
            walkingGraphStats={walkingGraphStats}
          />
          <ClusterLabPanel
            search={search}
            settings={settings}
            selectedCacheIds={selectedCacheIds}
            onSelectionChange={onSelectionChange}
            testRoute={testRoute}
            onTestRouteChange={onTestRouteChange}
          />
        </div>
      </aside>
    </div>
  );
}
