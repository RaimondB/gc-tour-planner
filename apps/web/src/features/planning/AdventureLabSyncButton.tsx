// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, type JSX } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AdventureLabSyncPhase } from "@gctp/shared/adventure-labs";
import type { LngLat } from "@gctp/shared/geo";
import { getAdventureLabSyncStatus, syncAdventureLabs } from "../../lib/api.js";

/** Human-readable status line per coarse sync phase (FR-I19). */
const PHASE_LABEL: Record<AdventureLabSyncPhase, string> = {
  queued: "Queued…",
  fetching: "Fetching Adventure Labs…",
  importing: "Importing stages…",
  completion: "Updating your completion…",
  done: "Done",
  failed: "Failed",
};

/**
 * "Sync Adventure Labs (this area)" button (FR-I19). Enqueues a background sync
 * for the current search area — refreshing Adventure Lab data and crossing off
 * completed stages — then polls the job and shows live progress. Self-contained:
 * owns its own mutation + poll so the planner just drops it in with the area.
 */
export function AdventureLabSyncButton({
  center,
  radiusM,
  online = true,
}: {
  center: LngLat;
  radiusM: number;
  online?: boolean;
}): JSX.Element {
  const [jobId, setJobId] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => syncAdventureLabs({ center, radiusM }),
    onSuccess: (res) => setJobId(res.jobId),
  });

  const status = useQuery({
    queryKey: ["al-sync", jobId],
    queryFn: () => getAdventureLabSyncStatus(jobId as string),
    enabled: jobId !== null,
    // Poll while the job is in flight; stop once it's done or failed.
    refetchInterval: (q) => {
      const phase = q.state.data?.phase;
      return phase === "done" || phase === "failed" ? false : 1500;
    },
  });

  const phase = status.data?.phase;
  const running =
    start.isPending ||
    (jobId !== null && phase !== "done" && phase !== "failed");

  const startError = start.isError
    ? ((start.error as Error).message ??
      "Couldn't start the sync. Is Adventure Lab sync enabled?")
    : null;

  return (
    <div className="al-sync">
      <button
        type="button"
        onClick={() => start.mutate()}
        disabled={running || !online}
        title={
          online ? undefined : "Syncing Adventure Labs needs a connection."
        }
      >
        {running ? "Syncing…" : "Sync Adventure Labs (this area)"}
      </button>

      {running && phase && (
        <p className="muted" role="status">
          {PHASE_LABEL[phase]}
        </p>
      )}

      {phase === "done" && status.data && !running && (
        <p className="muted" role="status">
          Synced — {status.data.importedCaches ?? 0} stage(s) updated
          {(status.data.crossedOff ?? 0) > 0
            ? `, ${status.data.crossedOff} completed crossed off`
            : ""}
          .
        </p>
      )}

      {(phase === "failed" || startError) && (
        <p className="planner-error" role="alert">
          {startError ?? status.data?.error ?? "Sync failed."}
        </p>
      )}

      <small className="muted">
        Refreshes Adventure Labs here and crosses off ones you&rsquo;ve done.
        Set your Geocaching GUID on the Account page first.
      </small>
    </div>
  );
}
