// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, uploadGpx, type UploadGpxResult } from "../../lib/api.js";

export function UploadDropzone(): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [dragging, setDragging] = useState(false);

  const mutation = useMutation<UploadGpxResult, Error, File>({
    // A Groundspeak "My Finds" PQ is auto-detected server-side (top-level
    // <name>) and its caches are marked found automatically — no toggle.
    mutationFn: (file) => uploadGpx(file),
    onSuccess: () => {
      // Invalidate every /caches view; new rows + finds show up on the map immediately.
      void queryClient.invalidateQueries({ queryKey: ["caches"] });
    },
  });

  const accept = (files: FileList | null | undefined) => {
    const file = files?.[0];
    if (!file) return;
    if (!/\.(gpx|xml)$/i.test(file.name)) {
      mutation.reset();
      return;
    }
    mutation.mutate(file);
  };

  return (
    <div className="upload">
      <div
        className={`dropzone${dragging ? " dropzone--active" : ""}`}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          accept(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".gpx,application/gpx+xml,application/xml,text/xml"
          hidden
          onChange={(e) => accept(e.target.files)}
        />
        <div className="dropzone__primary">
          {mutation.isPending
            ? "Uploading…"
            : "Drop a GPX here or click to choose"}
        </div>
        {!mutation.isPending && !mutation.isSuccess && (
          <div className="dropzone__hint">
            Pocket Query or &ldquo;My Finds&rdquo; — a My&nbsp;Finds export is
            detected automatically and its caches marked as found.
          </div>
        )}
        {mutation.isSuccess && (
          <UploadSummary result={mutation.data} />
        )}
        {mutation.isError && (
          <div className="dropzone__error">
            {mutation.error instanceof ApiError
              ? `Upload failed (${mutation.error.status}): ${mutation.error.body.slice(0, 120)}`
              : `Upload failed: ${mutation.error.message}`}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * "What just happened" summary rendered after a successful upload.
 * Breaks down the FR-I11 stats into something a user can read at a
 * glance: total + per-type + new/updated/stale + disabled/archived.
 */
function UploadSummary({ result }: { result: UploadGpxResult }): JSX.Element {
  const { stats, waypointsInserted, findsRecorded, warnings, myFinds } = result;
  // Sort cache types by count desc so the dominant types lead.
  const typeRows = Object.entries(stats.byType).sort(
    ([, a], [, b]) => b - a,
  );
  return (
    <div className="dropzone__success">
      {myFinds && (
        <div className="dropzone__myfinds">
          Detected a “My Finds” Pocket Query — {findsRecorded} cache
          {findsRecorded === 1 ? "" : "s"} marked as found.
        </div>
      )}
      <strong>{stats.total} caches</strong> ({stats.new} new, {stats.updated}{" "}
      updated
      {stats.stale > 0 && (
        <>
          ,{" "}
          <span
            title="Existing rows were newer than this PQ's export timestamp — skipped to avoid overwriting fresher data."
            style={{ color: "#ff6f00" }}
          >
            {stats.stale} stale-skipped
          </span>
        </>
      )}
      ){waypointsInserted > 0 && <>, {waypointsInserted} waypoints</>}
      {findsRecorded > 0 && <>, {findsRecorded} new finds</>}
      {(stats.disabled > 0 || stats.archived > 0) && (
        <div className="muted" style={{ marginTop: 4 }}>
          {stats.disabled > 0 && <>{stats.disabled} temporarily disabled</>}
          {stats.disabled > 0 && stats.archived > 0 && <> · </>}
          {stats.archived > 0 && <>{stats.archived} archived</>}
        </div>
      )}
      {typeRows.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {typeRows.map(([type, count]) => (
            <span key={type} className="chip" style={{ marginRight: 4 }}>
              {type}: {count}
            </span>
          ))}
        </div>
      )}
      {stats.exportedAt && (
        <div className="muted" style={{ marginTop: 4, fontSize: "0.85em" }}>
          PQ generated {new Date(stats.exportedAt).toLocaleString()}
        </div>
      )}
      {warnings.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary>{warnings.length} warning(s)</summary>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
