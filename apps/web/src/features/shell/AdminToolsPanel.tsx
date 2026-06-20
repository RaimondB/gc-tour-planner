// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, type JSX } from "react";
import { useMutation } from "@tanstack/react-query";
import type {
  TestRouteResponse,
  WalkingGraphResponse,
} from "@gctp/shared/tours";
import type { SearchParams } from "../../lib/search-params.js";
import { backfillAdventureLabIds } from "../../lib/api.js";
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
          <AdventureLabBackfillPanel />
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

/**
 * FR-I17: one-click backfill of Adventure Lab `adventure_id`s for older uploads
 * whose GPX lacked the `goto/<guid>` deep-link (so the planner couldn't group
 * their stages). Enqueues a background job that re-fetches each affected
 * adventure from Lab2Gpx; watch progress in Bull-Board (/api/admin/queues).
 */
function AdventureLabBackfillPanel(): JSX.Element {
  const [open, setOpen] = useState(false);
  const mutation = useMutation({ mutationFn: backfillAdventureLabIds });
  return (
    <details
      className="admin-precompute"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>Adventure Lab id backfill (admin)</summary>
      <div className="admin-precompute__body">
        <p className="muted">
          Re-fetches Adventure Lab stages that are missing their
          <code> adventure_id</code> (older uploads) from Lab2Gpx and fills it
          in, so &ldquo;complete adventures only&rdquo; works for them. Runs as
          a background job.
        </p>
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? "Enqueuing…" : "Backfill adventure ids"}
        </button>
        {mutation.isSuccess ? (
          <p className="muted">
            Job <code>{mutation.data.jobId}</code> enqueued — watch{" "}
            <a href="/api/admin/queues" target="_blank" rel="noreferrer">
              the queue
            </a>
            .
          </p>
        ) : null}
        {mutation.isError ? (
          <p className="error">{(mutation.error as Error).message}</p>
        ) : null}
      </div>
    </details>
  );
}
