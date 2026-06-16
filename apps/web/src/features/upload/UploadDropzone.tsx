// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useRef, useState, type JSX, type MouseEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, uploadGpx, type UploadGpxResult } from "../../lib/api.js";
import { AdvancedSection } from "../shell/AdvancedSection.js";
import { useOnline } from "../shell/ConnectivityProvider.js";

export function UploadDropzone(): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const online = useOnline();
  const [dragging, setDragging] = useState(false);
  const [solvedCoordinates, setSolvedCoordinates] = useState(false);

  const mutation = useMutation<
    UploadGpxResult,
    Error,
    { file: File; force?: boolean; solvedCoordinates?: boolean }
  >({
    // A Groundspeak "My Finds" PQ is auto-detected server-side (top-level
    // <name>) and its caches are marked found automatically — no toggle.
    mutationFn: ({ file, force, solvedCoordinates }) =>
      uploadGpx(file, { force, solvedCoordinates }),
    onSuccess: (result) => {
      // A duplicate skip wrote nothing — no point invalidating the map.
      if (result.duplicate) return;
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
    mutation.mutate({ file, solvedCoordinates });
  };

  return (
    <div className="upload">
      <AdvancedSection title="Upload options">
        <label className="checkbox" style={{ marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={solvedCoordinates}
            onChange={(e) => setSolvedCoordinates(e.target.checked)}
          />
          This file contains my solved coordinates
        </label>
        {solvedCoordinates && (
          <small className="muted" style={{ display: "block" }}>
            Every cache in the file is marked solved and its planning location
            set to the file&rsquo;s coordinates (Mystery solution or Multi
            final). The original posted coordinate is kept, and a normal Pocket
            Query re-upload won&rsquo;t overwrite the solved location.
          </small>
        )}
      </AdvancedSection>
      <div
        className={`dropzone${dragging ? " dropzone--active" : ""}${
          online ? "" : " dropzone--disabled"
        }`}
        onDragEnter={(e) => {
          e.preventDefault();
          if (online) setDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (online) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (online) accept(e.dataTransfer.files);
        }}
        onClick={() => online && inputRef.current?.click()}
        role="button"
        tabIndex={online ? 0 : -1}
        aria-disabled={!online}
        onKeyDown={(e) => {
          if (online && (e.key === "Enter" || e.key === " "))
            inputRef.current?.click();
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".gpx,application/gpx+xml,application/xml,text/xml"
          hidden
          disabled={!online}
          onChange={(e) => accept(e.target.files)}
        />
        <div className="dropzone__primary">
          {!online
            ? "GPX upload needs a connection"
            : mutation.isPending
              ? "Uploading…"
              : "Drop a GPX here or click to choose"}
        </div>
        {!mutation.isPending && !mutation.isSuccess && (
          <div className="dropzone__hint">
            Pocket Query or &ldquo;My Finds&rdquo; — a My&nbsp;Finds export is
            detected automatically and its caches marked as found.
          </div>
        )}
        {mutation.isSuccess &&
          (mutation.data.duplicate ? (
            <DuplicateNotice
              onForce={(e) => {
                e.stopPropagation();
                const file = mutation.variables?.file;
                if (file)
                  mutation.mutate({ file, force: true, solvedCoordinates });
              }}
            />
          ) : (
            <UploadSummary result={mutation.data} />
          ))}
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
 * FR-I12 — shown when the server skipped a byte-identical re-upload. The
 * caches are already in place from the first upload; offer an explicit
 * "upload anyway" that re-processes the stored file (`force`).
 */
function DuplicateNotice({
  onForce,
}: {
  onForce: (e: MouseEvent) => void;
}): JSX.Element {
  return (
    <div className="dropzone__success">
      <strong>Already uploaded.</strong> This exact file was uploaded before —
      nothing to do.
      <div style={{ marginTop: 6 }}>
        <button type="button" className="chip" onClick={onForce}>
          Upload anyway
        </button>
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
  const typeRows = Object.entries(stats.byType).sort(([, a], [, b]) => b - a);
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
