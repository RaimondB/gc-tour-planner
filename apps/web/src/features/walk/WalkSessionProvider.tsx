// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RouteProfileSettings } from "@gctp/shared/route-profiles";
import type { WalkReplanInput, WalkReplanResult } from "@gctp/shared/walks";
import { ApiError, markCacheFound, replanWalk } from "../../lib/api.js";
import { useAuth } from "../auth/AuthProvider.js";
import { useLocation } from "../location/LocationProvider.js";
import { useOnline } from "../shell/ConnectivityProvider.js";
import { calibrate } from "./calibration.js";
import { deadlineGuard, type GuardState } from "./deadline-guard.js";
import { autoReplanReason } from "./replan-trigger.js";
import { clearWalk, loadWalk, saveWalk } from "./walk-store.js";
import {
  effectiveDeadline,
  idsWith,
  isLogged,
  metersBetween,
  planOrigin,
  START_REACHED_M,
  walkReducer,
  type LngLat,
  type Outcome,
  type WalkAction,
  type WalkSession,
} from "./walk-session.js";

/**
 * The active ad-hoc walk (FR-T18, ADR-0040), mounted above the router so it
 * survives navigation (ADR-0029). The session lives in IndexedDB and is
 * written on every intent; the server holds nothing, so each replan sends the
 * whole walk. Found marks made offline are queued and sent once back online.
 */

/** Within this of a planned stop counts as "at" it (same as follow mode). */
const ARRIVE_M = 30;
/** Fixes worse than this don't trigger an arrival. */
const ARRIVE_MAX_ACCURACY_M = 50;
/** Further than this from the cache you were at, without logging it: you left. */
const LEAVE_M = 60;
const TICK_MS = 15_000;

export interface StartWalkOptions {
  profileId: string | null;
  profileName: string;
  profile: RouteProfileSettings;
  deadline: Date;
  /** Set for a duration (not a back-by time): the clock starts at the start point. */
  durationMinutes: number | null;
  startPoint: LngLat;
  returnPoint: LngLat;
}

interface WalkValue {
  session: WalkSession | null;
  /** False until the stored walk (if any) has been read back. */
  hydrated: boolean;
  replanning: boolean;
  /** Last replan problem, user-facing; null when fine. */
  error: string | null;
  guard: GuardState | null;
  start: (opts: StartWalkOptions) => void;
  end: () => void;
  log: (cacheId: number, outcome: Outcome) => void;
  lockNext: (cacheId: number | null) => void;
  previewLock: (cacheId: number) => Promise<WalkReplanResult | null>;
  replanNow: () => void;
  /** Start walking from here now, even before reaching the start point. */
  startNow: () => void;
}

const WalkContext = createContext<WalkValue | null>(null);

export function WalkSessionProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const { user } = useAuth();
  const location = useLocation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<WalkSession | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const sessionRef = useRef<WalkSession | null>(null);
  const planPositionRef = useRef<LngLat | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const positionRef = useRef<LngLat | null>(null);
  positionRef.current = location.position;

  // Restore a walk that was running before a reload / restart.
  useEffect(() => {
    let live = true;
    void loadWalk().then((stored) => {
      if (!live) return;
      if (stored) {
        sessionRef.current = stored;
        setSession(stored);
      }
      setHydrated(true);
    });
    return () => {
      live = false;
    };
  }, []);

  /** Apply + persist on intent (before any network call). */
  const commit = useCallback((next: WalkSession | null) => {
    sessionRef.current = next;
    setSession(next);
    if (next) void saveWalk(next);
    else void clearWalk();
  }, []);
  const dispatch = useCallback(
    (action: WalkAction) => {
      const cur = sessionRef.current;
      if (!cur) return;
      const next = walkReducer(cur, action);
      if (next !== cur) commit(next);
    },
    [commit],
  );

  // A walk never outlives the account that started it.
  const hadUser = useRef(false);
  useEffect(() => {
    if (user) hadUser.current = true;
    else if (hadUser.current && hydrated) commit(null);
  }, [user, hydrated, commit]);

  /**
   * `fresh` drops the current route from the request, so the server plans
   * from scratch instead of keeping it (manual Replan, or walked off the route).
   */
  const replan = useCallback(
    async (fresh = false) => {
      const s = sessionRef.current;
      const position = s ? planOrigin(s, positionRef.current) : null;
      if (!s || !position || !online) return;
      inFlight.current?.abort();
      const ac = new AbortController();
      inFlight.current = ac;
      setReplanning(true);
      try {
        const input = replanInput(s, position, location.accuracyM);
        const res = await replanWalk(
          fresh ? { ...input, previousOrder: [] } : input,
          ac.signal,
        );
        if (ac.signal.aborted || sessionRef.current?.id !== s.id) return;
        planPositionRef.current = position;
        dispatch({ type: "planned", plan: res, at: new Date().toISOString() });
        setError(null);
      } catch (err) {
        if (ac.signal.aborted) return;
        setError(
          err instanceof ApiError && err.status === 429
            ? "Replanning too often — try again in a minute."
            : "Couldn't replan — the last route still applies.",
        );
      } finally {
        if (inFlight.current === ac) {
          inFlight.current = null;
          setReplanning(false);
        }
      }
    },
    [online, location.accuracyM, dispatch],
  );

  const start = useCallback(
    (opts: StartWalkOptions) => {
      const gps = positionRef.current;
      planPositionRef.current = null;
      commit({
        id: crypto.randomUUID(),
        startedAt: new Date().toISOString(),
        profileId: opts.profileId,
        profileName: opts.profileName,
        profile: opts.profile,
        deadline: opts.deadline.toISOString(),
        durationMinutes: opts.durationMinutes,
        returnPoint: opts.returnPoint,
        startPoint: opts.startPoint,
        pendingStart:
          !gps || metersBetween(gps, opts.startPoint) > START_REACHED_M,
        log: [],
        atCache: null,
        lockedNextId: null,
        plan: null,
        plannedAt: null,
        plannedVisitMs: {},
        knownStops: {},
        calibration: { paceFactor: 1, dwellFactor: 1 },
        pendingFinds: [],
        track: [],
      });
      if (!location.enabled) location.enable();
      void replan();
    },
    [commit, location, replan],
  );

  const end = useCallback(() => {
    inFlight.current?.abort();
    planPositionRef.current = null;
    setError(null);
    commit(null);
  }, [commit]);

  const log = useCallback(
    (cacheId: number, outcome: Outcome) => {
      dispatch({
        type: "logged",
        cacheId,
        outcome,
        at: new Date().toISOString(),
      });
      void replan();
    },
    [dispatch, replan],
  );

  /**
   * What locking `cacheId` as the next stop would do, without committing —
   * so the UI can warn "~12 min late" before the user confirms (FR-T18).
   */
  const previewLock = useCallback(
    async (cacheId: number): Promise<WalkReplanResult | null> => {
      const s = sessionRef.current;
      const position = s ? planOrigin(s, positionRef.current) : null;
      if (!s || !position || !online) return null;
      try {
        return await replanWalk(
          replanInput(
            { ...s, lockedNextId: cacheId },
            position,
            location.accuracyM,
          ),
        );
      } catch {
        return null;
      }
    },
    [online, location.accuracyM],
  );

  const startNow = useCallback(() => {
    dispatch({ type: "started", at: new Date().toISOString() });
    void replan();
  }, [dispatch, replan]);

  const lockNext = useCallback(
    (cacheId: number | null) => {
      dispatch({ type: "locked", cacheId });
      void replan();
    },
    [dispatch, replan],
  );

  // Position updates: record the track and notice arrivals at planned stops.
  useEffect(() => {
    const s = sessionRef.current;
    const p = location.position;
    if (!s || !p) return;
    if (s.pendingStart) {
      // Nothing to track on the way to the start (it's often a drive).
      if (metersBetween(p, s.startPoint) <= START_REACHED_M) {
        dispatch({ type: "started", at: new Date().toISOString() });
      }
      return;
    }
    dispatch({ type: "tracked", point: [p[0], p[1], Date.now()] });
    const at = s.atCache ? s.knownStops[s.atCache.cacheId] : undefined;
    if (s.atCache && at && metersBetween(p, at.location) > LEAVE_M) {
      dispatch({ type: "departed", cacheId: s.atCache.cacheId });
    }
    if (
      location.accuracyM !== null &&
      location.accuracyM > ARRIVE_MAX_ACCURACY_M
    )
      return;
    for (const stop of s.plan?.order ?? []) {
      if (
        !isLogged(s, stop.cacheId) &&
        metersBetween(p, stop.location) <= ARRIVE_M
      ) {
        dispatch({
          type: "arrived",
          cacheId: stop.cacheId,
          at: new Date().toISOString(),
        });
        break;
      }
    }
  }, [location.position, location.accuracyM, dispatch]);

  // The clock: guard refresh + automatic replans.
  useEffect(() => {
    if (!session) return;
    const t = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(t);
  }, [session]);
  useEffect(() => {
    const s = sessionRef.current;
    if (!s || !online || replanning || document.visibilityState === "hidden")
      return;
    const reason = autoReplanReason(
      s,
      now,
      planOrigin(s, location.position),
      s.pendingStart ? null : location.accuracyM,
      planPositionRef.current,
    );
    if (reason) void replan(reason === "off-plan");
  }, [now, online, replanning, location.position, location.accuracyM, replan]);

  // Send Found marks queued while offline.
  useEffect(() => {
    const pending = session?.pendingFinds ?? [];
    if (!online || pending.length === 0) return;
    let live = true;
    void Promise.allSettled(pending.map((id) => markCacheFound(id))).then(
      (results) => {
        if (!live) return;
        const sent = pending.filter(
          (_, i) => results[i]!.status === "fulfilled",
        );
        if (sent.length > 0) {
          dispatch({ type: "findsFlushed", cacheIds: sent });
          void queryClient.invalidateQueries({ queryKey: ["caches"] });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [online, session?.pendingFinds, dispatch, queryClient]);

  const guard = useMemo(
    () =>
      session && !session.pendingStart
        ? deadlineGuard(session, now, location.position)
        : null,
    [session, now, location.position],
  );

  const value = useMemo<WalkValue>(
    () => ({
      session,
      hydrated,
      replanning,
      error,
      guard,
      start,
      end,
      log,
      lockNext,
      previewLock,
      replanNow: () => void replan(true),
      startNow,
    }),
    [
      session,
      hydrated,
      replanning,
      error,
      guard,
      start,
      end,
      log,
      lockNext,
      previewLock,
      replan,
      startNow,
    ],
  );

  return <WalkContext.Provider value={value}>{children}</WalkContext.Provider>;
}

export function useWalk(): WalkValue {
  const v = useContext(WalkContext);
  if (!v) throw new Error("useWalk must be used inside WalkSessionProvider");
  return v;
}

/** The stateless replan request for this walk, from here. */
function replanInput(
  s: WalkSession,
  position: LngLat,
  accuracyM: number | null,
): WalkReplanInput {
  const logged = new Set(s.log.map((l) => l.cacheId));
  return {
    position,
    ...(accuracyM !== null ? { accuracyM } : {}),
    returnPoint: s.returnPoint,
    deadline: effectiveDeadline(s, new Date()),
    now: new Date().toISOString(),
    profile: s.profile,
    calibration: calibrate(s),
    visitedIds: idsWith(s, "found"),
    skippedIds: idsWith(s, "skipped"),
    dnfIds: idsWith(s, "dnf"),
    ...(s.lockedNextId !== null ? { lockedNextId: s.lockedNextId } : {}),
    previousOrder: (s.plan?.order ?? [])
      .map((o) => o.cacheId)
      .filter((id) => !logged.has(id)),
  };
}
