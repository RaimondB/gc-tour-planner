// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CacheSummaryDTO } from "@gctp/shared/caches";
import type { PlanResult, SavedTourDetail } from "@gctp/shared/tours";
import { getTour } from "../../lib/api.js";
import { useLocalStorageState } from "../../lib/persistent-state.js";
import {
  cacheTourDetail,
  pruneCachedTours,
  readCachedTourDetail,
} from "../../lib/tour-cache.js";
import { tourCachesToSummaries } from "./saved-tour-view.js";
import { useOnline } from "../shell/ConnectivityProvider.js";
import { useAuth } from "../auth/AuthProvider.js";

/**
 * Single source of truth for "the currently-open saved tour" (FR-W3). Replaces
 * the tangle of `planResult`/`openedTour`/`tourCaches`/`persistedTourId` state
 * and the three racing mount effects that previously lived in `App.tsx`.
 *
 * - **Which tour** is a single persisted pointer (`opened-tour-id` in
 *   localStorage), written on the *intent* to open — so a slow/failed fetch can
 *   never leave it pointing at the previous tour (the "wrong tour resumes" bug).
 * - **The data** comes from React Query (`["tour", id]`, the online/dedup cache)
 *   with a durable IndexedDB mirror underneath, so resume / switch renders
 *   instantly offline without depending on the service-worker HTTP cache.
 * - Opening = `openTour(id)`. Everything else (planResult, marker snapshots, the
 *   offline preview flag) is *derived* from the resolved detail.
 */
interface TourSessionValue {
  /** The open saved-tour id, or null when none is open. */
  openTourId: string | null;
  /** The resolved tour (fresh server copy, else the durable offline copy). */
  detail: SavedTourDetail | null;
  /** The route/plan to render — `detail.plan`. */
  planResult: PlanResult | null;
  /** Map-ready cache markers from the stored snapshots. */
  tourCaches: readonly CacheSummaryDTO[] | null;
  /** Id + offline-snapshot flag for the basemap fallback. */
  openedTour: { id: string; hasPreview: boolean } | null;
  isLoading: boolean;
  /** Set only when the open failed and there's no copy to fall back on. */
  error: string | null;
  openTour: (id: string) => void;
  closeTour: () => void;
  /** Flip `hasPreview` after a background snapshot upload (FR-W4 backfill). */
  markPreviewCaptured: (id: string) => void;
}

const TourSessionContext = createContext<TourSessionValue | null>(null);

export function TourSessionProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const qc = useQueryClient();
  const online = useOnline();
  const { status } = useAuth();
  const [openTourId, setOpenTourId] = useLocalStorageState<string | null>(
    "opened-tour-id",
    null,
  );

  // The durable offline copy for the open id. Cleared the instant the id
  // changes (no stale previous-tour flash) and reloaded from IndexedDB.
  const [idbDetail, setIdbDetail] = useState<SavedTourDetail | null>(null);
  useEffect(() => {
    let cancelled = false;
    setIdbDetail(null);
    if (!openTourId) return;
    void readCachedTourDetail(openTourId).then((d) => {
      if (!cancelled && d) setIdbDetail(d);
    });
    return () => {
      cancelled = true;
    };
  }, [openTourId]);

  const detailQuery = useQuery({
    queryKey: ["tour", openTourId],
    queryFn: () => getTour(openTourId as string),
    enabled: openTourId != null,
    // The detail is heavy (~hundreds of KB) and must stay put while open; the
    // global 60s gcTime would otherwise evict it.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

  // Mirror the fresh server copy into IndexedDB so it's there offline next time.
  const fresh = detailQuery.data;
  useEffect(() => {
    if (fresh) void cacheTourDetail(fresh);
  }, [fresh]);

  // Prefer the fresh copy; fall back to the durable copy offline. The id guard
  // prevents a previous tour's IndexedDB copy from rendering during a switch.
  const detail =
    detailQuery.data ??
    (idbDetail && idbDetail.id === openTourId ? idbDetail : null);

  // Evict the offline library on sign-out so a cached tour never outlives the
  // account that owns it. (Anonymous → also clears; harmless.)
  useEffect(() => {
    if (status === "unauthenticated") {
      setOpenTourId(null);
      void pruneCachedTours([]);
    }
  }, [status, setOpenTourId]);

  const openTour = useCallback(
    (id: string) => setOpenTourId(id),
    [setOpenTourId],
  );
  const closeTour = useCallback(() => setOpenTourId(null), [setOpenTourId]);

  const markPreviewCaptured = useCallback(
    (id: string) => {
      qc.setQueryData<SavedTourDetail>(["tour", id], (d) =>
        d && d.id === id ? { ...d, hasPreview: true } : d,
      );
      setIdbDetail((d) => (d && d.id === id ? { ...d, hasPreview: true } : d));
    },
    [qc],
  );

  const tourCaches = useMemo(
    () => (detail ? tourCachesToSummaries(detail.plan.caches) : null),
    [detail],
  );
  const openedTour = useMemo(
    () => (detail ? { id: detail.id, hasPreview: detail.hasPreview } : null),
    [detail],
  );
  const error =
    !detail && detailQuery.isError
      ? online
        ? "Couldn’t open that tour. Try again."
        : "This tour isn’t available offline — open it once while online to download it."
      : null;

  const value = useMemo<TourSessionValue>(
    () => ({
      openTourId,
      detail,
      planResult: detail?.plan ?? null,
      tourCaches,
      openedTour,
      isLoading: detailQuery.isLoading,
      error,
      openTour,
      closeTour,
      markPreviewCaptured,
    }),
    [
      openTourId,
      detail,
      tourCaches,
      openedTour,
      detailQuery.isLoading,
      error,
      openTour,
      closeTour,
      markPreviewCaptured,
    ],
  );

  return (
    <TourSessionContext.Provider value={value}>
      {children}
    </TourSessionContext.Provider>
  );
}

export function useTourSession(): TourSessionValue {
  const ctx = useContext(TourSessionContext);
  if (!ctx) {
    throw new Error("useTourSession must be used within a TourSessionProvider");
  }
  return ctx;
}
