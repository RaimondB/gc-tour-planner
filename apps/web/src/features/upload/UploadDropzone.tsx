// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, uploadGpx, type UploadGpxResult } from "../../lib/api.js";

interface MutationInput {
  file: File;
  markAsFound: boolean;
}

export function UploadDropzone(): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [dragging, setDragging] = useState(false);
  const [markAsFound, setMarkAsFound] = useState(false);

  const mutation = useMutation<UploadGpxResult, Error, MutationInput>({
    mutationFn: ({ file, markAsFound: m }) =>
      uploadGpx(file, { markAsFound: m }),
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
    mutation.mutate({ file, markAsFound });
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
            : markAsFound
              ? "Drop a 'My Finds' GPX here or click to choose"
              : "Drop a GPX here or click to choose"}
        </div>
        {mutation.isSuccess && (
          <div className="dropzone__success">
            {mutation.data.cachesUpserted} caches,{" "}
            {mutation.data.waypointsInserted} waypoints
            {mutation.data.findsRecorded > 0 && (
              <>, {mutation.data.findsRecorded} new finds</>
            )}
            {mutation.data.warnings.length > 0 && (
              <details>
                <summary>{mutation.data.warnings.length} warning(s)</summary>
                <ul>
                  {mutation.data.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {mutation.isError && (
          <div className="dropzone__error">
            {mutation.error instanceof ApiError
              ? `Upload failed (${mutation.error.status}): ${mutation.error.body.slice(0, 120)}`
              : `Upload failed: ${mutation.error.message}`}
          </div>
        )}
      </div>

      <label
        className="checkbox upload__mode"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={markAsFound}
          onChange={(e) => setMarkAsFound(e.target.checked)}
        />
        Upload as &ldquo;My Finds&rdquo; (mark each cache as found)
      </label>
    </div>
  );
}
