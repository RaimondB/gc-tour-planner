// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PrecomputeKind } from "@gctp/shared/admin";
import {
  fetchPrecomputeSummary,
  fetchStaleCaches,
  retriggerOne,
  retriggerStale,
} from "../../lib/api.js";

/**
 * Operator dashboard for the upload-triggered precompute jobs. Sits in the
 * left pane behind a collapse toggle so it's out of the way of the day-to-
 * day planner workflow. Bull-Board (queue-level ops) lives at /admin/queues
 * in a separate browser tab — link at the bottom.
 *
 * Auto-refresh: 5 s. Cheap enough (one COUNT query on a view) that we don't
 * need long-polling or websockets at this scale.
 */
export function AdminPrecomputePanel(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="admin-precompute"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>Precompute jobs (admin)</summary>
      {open ? <AdminBody /> : null}
    </details>
  );
}

function AdminBody(): JSX.Element {
  const summaryQuery = useQuery({
    queryKey: ["admin", "precompute", "summary"],
    queryFn: fetchPrecomputeSummary,
    refetchInterval: 5_000,
  });

  return (
    <div className="admin-precompute__body">
      {summaryQuery.isPending ? (
        <p>Loading summary…</p>
      ) : summaryQuery.isError ? (
        <p className="error">
          {`Failed to load: ${(summaryQuery.error as Error).message}`}
        </p>
      ) : (
        <>
          <p className="muted">
            OSRM extract:{" "}
            <code>{summaryQuery.data.osrmVersion}</code>
          </p>
          <KindTile kind="walking" counts={summaryQuery.data.walking} />
          {/* Landuse precompute moved off per-cache tracking in ADR-0009.
              See /admin/landuse/status for landuse import + replication
              health. */}
        </>
      )}
      <p className="muted">
        Queue-level ops (pause / retry / clean failed):{" "}
        <a href="/admin/queues" target="_blank" rel="noreferrer">
          /admin/queues →
        </a>
      </p>
    </div>
  );
}

interface KindTileProps {
  kind: PrecomputeKind;
  counts: {
    fresh: number;
    stale: number;
    failed: number;
    in_progress: number;
    pending: number;
    missing: number;
  };
}

function KindTile({ kind, counts }: KindTileProps): JSX.Element {
  const queryClient = useQueryClient();
  const [showFailed, setShowFailed] = useState(false);
  const totalStale =
    counts.stale +
    counts.failed +
    counts.in_progress +
    counts.pending +
    counts.missing;

  const retriggerMutation = useMutation({
    mutationFn: () => retriggerStale({ kind }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["admin", "precompute"],
      });
    },
  });

  const handleRetrigger = () => {
    if (totalStale === 0) return;
    const ok = window.confirm(
      `Retrigger ${kind} precompute for ${totalStale} stale cache(s)?`,
    );
    if (!ok) return;
    retriggerMutation.mutate();
  };

  return (
    <div className="admin-precompute__tile">
      <h4>{kind === "walking" ? "Walking paths" : "Landuse"}</h4>
      <dl className="admin-precompute__counts">
        <Pair label="fresh" value={counts.fresh} />
        <Pair label="stale" value={counts.stale} />
        <Pair label="failed" value={counts.failed} />
        <Pair label="in progress" value={counts.in_progress} />
        <Pair label="missing" value={counts.missing} />
      </dl>
      <div className="admin-precompute__actions">
        <button
          type="button"
          onClick={handleRetrigger}
          disabled={totalStale === 0 || retriggerMutation.isPending}
        >
          {retriggerMutation.isPending
            ? "Enqueuing…"
            : `Retrigger stale (${totalStale})`}
        </button>
        <button type="button" onClick={() => setShowFailed((v) => !v)}>
          {showFailed ? "Hide failed list" : "Show failed list"}
        </button>
      </div>
      {retriggerMutation.isSuccess ? (
        <p className="muted">
          {`Enqueued ${retriggerMutation.data.enqueued} cache(s) across ${retriggerMutation.data.jobIds.length} job(s).`}
        </p>
      ) : null}
      {retriggerMutation.isError ? (
        <p className="error">
          {`Retrigger failed: ${(retriggerMutation.error as Error).message}`}
        </p>
      ) : null}
      {showFailed ? <FailedList kind={kind} /> : null}
    </div>
  );
}

function Pair({
  label,
  value,
}: {
  label: string;
  value: number;
}): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value.toLocaleString()}</dd>
    </>
  );
}

function FailedList({ kind }: { kind: PrecomputeKind }): JSX.Element {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ["admin", "precompute", "stale", kind],
    queryFn: () => fetchStaleCaches(kind, { limit: 100 }),
    refetchInterval: 5_000,
  });

  const retryOneMutation = useMutation({
    mutationFn: (cacheId: number) => retriggerOne({ cacheId, kind }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["admin", "precompute"],
      });
    },
  });

  if (list.isPending) return <p>Loading list…</p>;
  if (list.isError) {
    return (
      <p className="error">
        {`Failed to load: ${(list.error as Error).message}`}
      </p>
    );
  }
  if (list.data.entries.length === 0) {
    return <p className="muted">No stale caches for this kind.</p>;
  }
  return (
    <table className="admin-precompute__list">
      <thead>
        <tr>
          <th>cache id</th>
          <th>state</th>
          <th>last error</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {list.data.entries.map((entry) => (
          <tr key={entry.cacheId}>
            <td>{entry.cacheId}</td>
            <td>{entry.state ?? "(missing)"}</td>
            <td title={entry.errorText ?? undefined}>
              {entry.errorText
                ? `${entry.errorText.slice(0, 60)}${entry.errorText.length > 60 ? "…" : ""}`
                : "—"}
            </td>
            <td>
              <button
                type="button"
                onClick={() => retryOneMutation.mutate(entry.cacheId)}
                disabled={retryOneMutation.isPending}
              >
                Retry
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
