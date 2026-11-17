// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useMemo, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag, Lock, Navigation, RefreshCw } from "lucide-react";
import { listRouteProfiles, saveTour } from "../../lib/api.js";
import { parkingNavTarget, walkNavTarget } from "../../lib/maps.js";
import { useLocalStorageState } from "../../lib/persistent-state.js";
import { useLocation } from "../location/LocationProvider.js";
import { ROUTE_PROFILES_KEY } from "../route-profiles/RouteProfilesSection.js";
import { useOnline } from "../shell/ConnectivityProvider.js";
import type { GuardState } from "./deadline-guard.js";
import { walkToPlanResult } from "./walk-to-tour.js";
import { useWalk } from "./WalkSessionProvider.js";
import {
  isLogged,
  metersBetween,
  nextStopId,
  type LngLat,
  type Outcome,
} from "./walk-session.js";

/**
 * The ad-hoc walk's command-panel content (FR-T18): the start form, the
 * always-visible peek (deadline guard, next stop, Found / DNF / Skip) and the
 * body (the route ahead with "Go here next", the log, end / save).
 */

const DURATIONS = [30, 60, 90, 120, 180, 240] as const;

const hhmm = (d: Date | string): string =>
  new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const distance = (m: number): string =>
  m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;

function NavLink({
  to,
  label,
  drive = false,
}: {
  to: LngLat;
  label: string;
  /** Driving directions (getting to the start) instead of walking. */
  drive?: boolean;
}): JSX.Element {
  const nav = (drive ? parkingNavTarget : walkNavTarget)({ coordinates: to });
  return (
    <a
      className="walk-btn walk-btn--ghost"
      href={nav.href}
      {...(nav.external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      <Navigation size={16} aria-hidden="true" /> {label}
    </a>
  );
}

/**
 * "Go here next" with the agreed safety step (FR-T18): preview the lock; if it
 * can't fit, say how late it makes you and only lock on confirm.
 */
export function useGoHereNext(): {
  goHereNext: (cacheId: number) => Promise<void>;
  checking: number | null;
} {
  const walk = useWalk();
  const [checking, setChecking] = useState<number | null>(null);
  const goHereNext = async (cacheId: number) => {
    setChecking(cacheId);
    const preview = await walk.previewLock(cacheId);
    setChecking(null);
    if (
      preview &&
      !preview.feasible &&
      !window.confirm(
        `Going there first gets you back about ${Math.round(preview.lateByMinutes ?? 0)} min late. Go anyway?`,
      )
    ) {
      return;
    }
    walk.lockNext(cacheId);
  };
  return { goHereNext, checking };
}

/* --- start ---------------------------------------------------------------- */

export type PickTarget = "start" | "end" | null;

export interface WalkStartFormProps {
  /** Points picked on the map for the start / a different end. */
  picked: { start: LngLat | null; end: LngLat | null };
  /** Which point a map tap sets right now. */
  pickTarget: PickTarget;
  onPickTargetChange: (target: PickTarget) => void;
  /** The open tour's parking, offered as a start / end point. */
  tourParking: { point: LngLat; label: string } | null;
  onCancel: () => void;
}

type PlaceChoice = "here" | "map" | "tour";

function PlaceChoices({
  name,
  value,
  onChange,
  picked,
  picking,
  tourParking,
}: {
  name: string;
  value: PlaceChoice;
  onChange: (v: PlaceChoice) => void;
  picked: LngLat | null;
  picking: boolean;
  tourParking: WalkStartFormProps["tourParking"];
}): JSX.Element {
  return (
    <>
      <label className="checkbox">
        <input
          type="radio"
          name={name}
          checked={value === "here"}
          onChange={() => onChange("here")}
        />
        Where I am now
      </label>
      <label className="checkbox">
        <input
          type="radio"
          name={name}
          checked={value === "map"}
          onChange={() => onChange("map")}
        />
        A point on the map
      </label>
      {value === "map" && (
        <small className="muted">
          {picking
            ? picked
              ? "Picked. Tap the map again to move it."
              : "Tap the map to set it."
            : picked
              ? "Picked."
              : ""}
        </small>
      )}
      {tourParking && (
        <label className="checkbox">
          <input
            type="radio"
            name={name}
            checked={value === "tour"}
            onChange={() => onChange("tour")}
          />
          {tourParking.label}
        </label>
      )}
    </>
  );
}

export function WalkStartForm({
  picked,
  pickTarget,
  onPickTargetChange,
  tourParking,
  onCancel,
}: WalkStartFormProps): JSX.Element {
  const walk = useWalk();
  const location = useLocation();
  const online = useOnline();
  const profiles = useQuery({
    queryKey: ROUTE_PROFILES_KEY,
    queryFn: listRouteProfiles,
    staleTime: 5 * 60_000,
  });
  const [lastProfileId, setLastProfileId] = useLocalStorageState<string | null>(
    "walk-profile-id",
    null,
  );
  const profile =
    profiles.data?.find((p) => p.id === lastProfileId) ?? profiles.data?.[0];
  /** A duration (the clock starts at the start point) or a fixed back-by time. */
  const [minutes, setMinutes] = useState<number | null>(null);
  const [backBy, setBackBy] = useState<Date | null>(null);
  const duration = minutes ?? profile?.settings.budget.durationMinutes ?? 120;
  const shownBackBy = backBy ?? new Date(Date.now() + duration * 60_000);

  const [startChoice, setStartChoice] = useState<PlaceChoice>("here");
  const [endSameAsStart, setEndSameAsStart] = useState(true);
  const [endChoice, setEndChoice] = useState<PlaceChoice>("here");

  const placeOf = (c: PlaceChoice, mapPoint: LngLat | null): LngLat | null =>
    c === "here"
      ? location.position
      : c === "map"
        ? mapPoint
        : (tourParking?.point ?? null);
  const startPoint = placeOf(startChoice, picked.start);
  const endPoint = endSameAsStart ? startPoint : placeOf(endChoice, picked.end);
  const needsGps =
    startChoice === "here" || (!endSameAsStart && endChoice === "here");

  const chooseStart = (c: PlaceChoice) => {
    setStartChoice(c);
    onPickTargetChange(c === "map" ? "start" : null);
  };
  const chooseEnd = (c: PlaceChoice) => {
    setEndChoice(c);
    onPickTargetChange(c === "map" ? "end" : null);
  };

  const ready = !!profile && !!startPoint && !!endPoint && online;

  return (
    <div className="walk-start">
      <p className="muted">
        Plan as you go: pick a profile and how long you have. The route keeps
        updating as you find caches, and always gets you back in time.
      </p>

      {needsGps && !location.position && (
        <div className="walk-start__location">
          {location.enabled ? (
            <span className="muted">Waiting for GPS…</span>
          ) : (
            <button
              type="button"
              className="walk-btn"
              onClick={location.enable}
            >
              Turn on location
            </button>
          )}
        </div>
      )}

      <label className="walk-field">
        <span>Profile</span>
        <select
          value={profile?.id ?? ""}
          onChange={(e) => {
            setLastProfileId(e.target.value);
            setMinutes(null);
          }}
        >
          {profiles.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <div className="walk-field">
        <span>Time</span>
        <div className="walk-chips" role="group" aria-label="Walk duration">
          {DURATIONS.map((m) => (
            <button
              key={m}
              type="button"
              className={`walk-chip${!backBy && duration === m ? " walk-chip--on" : ""}`}
              aria-pressed={!backBy && duration === m}
              onClick={() => {
                setMinutes(m);
                setBackBy(null);
              }}
            >
              {m < 60 ? `${m} min` : `${m / 60} h`}
            </button>
          ))}
        </div>
        <label className="walk-backby">
          Back by
          <input
            type="time"
            value={hhmm(shownBackBy)}
            onChange={(e) => {
              const [h, m] = e.target.value.split(":").map(Number);
              if (h === undefined || m === undefined) return;
              const t = new Date();
              t.setHours(h, m, 0, 0);
              if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
              setBackBy(t);
            }}
          />
        </label>
        {!backBy && startChoice !== "here" && (
          <small className="muted">
            The {duration < 60 ? `${duration} min` : `${duration / 60} h`} start
            when you reach the start point.
          </small>
        )}
      </div>

      <fieldset className="walk-field">
        <legend>Start from</legend>
        <PlaceChoices
          name="walk-start"
          value={startChoice}
          onChange={chooseStart}
          picked={picked.start}
          picking={pickTarget === "start"}
          tourParking={tourParking}
        />
      </fieldset>

      <fieldset className="walk-field">
        <legend>End at</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={endSameAsStart}
            onChange={(e) => {
              setEndSameAsStart(e.target.checked);
              onPickTargetChange(
                !e.target.checked && endChoice === "map" ? "end" : null,
              );
            }}
          />
          Back where I start
        </label>
        {!endSameAsStart && (
          <PlaceChoices
            name="walk-end"
            value={endChoice}
            onChange={chooseEnd}
            picked={picked.end}
            picking={pickTarget === "end"}
            tourParking={tourParking}
          />
        )}
      </fieldset>

      <div className="walk-actions">
        <button
          type="button"
          className="walk-btn walk-btn--primary"
          disabled={!ready}
          title={online ? undefined : "Starting a walk needs a connection."}
          onClick={() => {
            if (!profile || !startPoint || !endPoint) return;
            setLastProfileId(profile.id);
            onPickTargetChange(null);
            walk.start({
              profileId: profile.id,
              profileName: profile.name,
              profile: profile.settings,
              deadline: backBy ?? new Date(Date.now() + duration * 60_000),
              durationMinutes: backBy ? null : duration,
              startPoint,
              returnPoint: endPoint,
            });
          }}
        >
          Start walk ·{" "}
          {backBy || startChoice === "here"
            ? `back by ${hhmm(shownBackBy)}`
            : duration < 60
              ? `${duration} min`
              : `${duration / 60} h`}
        </button>
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* --- active: peek ---------------------------------------------------------- */

function GuardLine({ guard }: { guard: GuardState }): JSX.Element {
  const slack = Math.round(guard.slackMinutes);
  const text =
    guard.status === "late"
      ? `You're past your deadline — about ${Math.round(guard.minutesHome)} min home`
      : guard.status === "head-back"
        ? `Head back now — about ${Math.round(guard.minutesHome)} min home`
        : `Leave the last cache by ${hhmm(guard.leaveBy)} · ${slack} min spare`;
  return (
    <p className={`walk-guard walk-guard--${guard.status}`} role="status">
      {text}
    </p>
  );
}

export function WalkPeek({
  onShowPlanner,
}: {
  /** Switch the panel back to the planner; the walk keeps running. */
  onShowPlanner: () => void;
}): JSX.Element | null {
  const walk = useWalk();
  const location = useLocation();
  const online = useOnline();
  const s = walk.session;
  if (!s) return null;

  const plannerButton = (
    <button
      type="button"
      className="walk-btn walk-btn--ghost"
      onClick={onShowPlanner}
    >
      Planner
    </button>
  );

  if (s.pendingStart) {
    const toStart = location.position
      ? metersBetween(location.position, s.startPoint)
      : null;
    const stops = s.plan?.order.length ?? 0;
    const length =
      s.durationMinutes === null
        ? null
        : s.durationMinutes < 60
          ? `${s.durationMinutes} min`
          : `${s.durationMinutes / 60} h`;
    return (
      <div className="walk-peek">
        <p className="walk-guard walk-guard--ok" role="status">
          {length
            ? `Not started yet — your ${length} start when you reach the start point.`
            : `Not started yet — back by ${hhmm(s.deadline)}.`}
        </p>
        <p className="walk-next">
          {toStart !== null && `Start point ${distance(toStart)} away · `}
          {s.plan
            ? `${stops} cache${stops === 1 ? "" : "s"} planned from there`
            : "Planning…"}
        </p>
        <div className="walk-actions">
          <NavLink to={s.startPoint} label="Directions to start" drive />
          <button type="button" className="walk-btn" onClick={walk.startNow}>
            Start walking now
          </button>
          {plannerButton}
        </div>
      </div>
    );
  }

  const nextId = nextStopId(s);
  const next =
    s.plan?.order.find((o) => o.cacheId === nextId) ??
    (nextId !== null && s.knownStops[nextId]
      ? { cacheId: nextId, ...s.knownStops[nextId]!, arriveAt: null }
      : null);
  const at = s.atCache && !isLogged(s, s.atCache.cacheId) ? s.atCache : null;
  const atStop = at ? s.knownStops[at.cacheId] : null;
  const away =
    next && location.position
      ? metersBetween(location.position, next.location)
      : null;
  const outcome = (cacheId: number, o: Outcome) => () => walk.log(cacheId, o);

  return (
    <div className="walk-peek">
      {walk.guard && <GuardLine guard={walk.guard} />}
      {s.plan && !s.plan.feasible && (
        <p className="walk-warning" role="alert">
          {s.plan.reason}
          {s.plan.lateByMinutes !== undefined &&
            ` (~${Math.round(s.plan.lateByMinutes)} min late)`}
        </p>
      )}

      {at && atStop ? (
        <div className="walk-at">
          <strong>
            You&rsquo;re at {atStop.code} {atStop.name}
          </strong>
          <div className="walk-actions">
            <button
              type="button"
              className="walk-btn walk-btn--primary"
              onClick={outcome(at.cacheId, "found")}
            >
              Found
            </button>
            <button
              type="button"
              className="walk-btn"
              onClick={outcome(at.cacheId, "dnf")}
            >
              DNF
            </button>
            <button
              type="button"
              className="walk-btn"
              onClick={outcome(at.cacheId, "skipped")}
            >
              Skip
            </button>
          </div>
        </div>
      ) : next ? (
        <div className="walk-next">
          <span>
            Next: <strong>{next.code}</strong> {next.name}
            {away !== null && ` · ${distance(away)}`}
            {next.arriveAt && ` · arrive ${hhmm(next.arriveAt)}`}
            {s.lockedNextId === next.cacheId && (
              <Lock size={14} aria-label="You chose this one" />
            )}
          </span>
          <div className="walk-actions">
            <NavLink to={next.location} label="Navigate" />
            <button
              type="button"
              className="walk-btn"
              onClick={outcome(next.cacheId, "found")}
            >
              Found
            </button>
            <button
              type="button"
              className="walk-btn walk-btn--ghost"
              onClick={outcome(next.cacheId, "skipped")}
            >
              Skip
            </button>
          </div>
        </div>
      ) : (
        s.plan && (
          <p className="walk-next">No more caches fit — time to head back.</p>
        )
      )}

      <div className="walk-actions walk-actions--small">
        <button
          type="button"
          className="walk-btn walk-btn--ghost"
          onClick={walk.replanNow}
          disabled={!online || walk.replanning}
        >
          <RefreshCw
            size={14}
            aria-hidden="true"
            className={walk.replanning ? "walk-spin" : undefined}
          />{" "}
          Replan
        </button>
        <NavLink to={s.returnPoint} label="Head back" />
        {plannerButton}
      </div>
      {!online && (
        <p className="muted walk-note">
          Offline — your last route and the back-by time still apply; Found is
          saved and sent when you&rsquo;re back online.
        </p>
      )}
      {walk.error && online && <p className="muted walk-note">{walk.error}</p>}
    </div>
  );
}

/* --- active: body ---------------------------------------------------------- */

const MARK: Record<Outcome, string> = {
  found: "✓ found",
  dnf: "✕ DNF",
  skipped: "– skipped",
};

export function WalkBody(): JSX.Element | null {
  const walk = useWalk();
  const online = useOnline();
  const queryClient = useQueryClient();
  const { goHereNext, checking } = useGoHereNext();
  const s = walk.session;

  const save = useMutation({
    mutationFn: async () => {
      if (!s) return;
      const plan = walkToPlanResult(s, new Date());
      if (!plan) return;
      const date = new Date(s.startedAt).toLocaleDateString([], {
        day: "numeric",
        month: "short",
      });
      await saveTour({ name: `${s.profileName} walk ${date}`, plan });
      await queryClient.invalidateQueries({ queryKey: ["tours"] });
      await queryClient.invalidateQueries({ queryKey: ["tour-footprints"] });
    },
    onSuccess: () => walk.end(),
  });

  const upcoming = useMemo(
    () => (s?.plan?.order ?? []).filter((o) => !isLogged(s!, o.cacheId)),
    [s],
  );
  if (!s) return null;

  const visits = s.log.filter((l) => l.outcome !== "skipped").length;

  return (
    <div className="walk-body">
      <h3 className="walk-heading">
        {s.profileName} ·{" "}
        {s.pendingStart && s.durationMinutes !== null
          ? `${s.durationMinutes < 60 ? `${s.durationMinutes} min` : `${s.durationMinutes / 60} h`} from the start point`
          : `back by ${hhmm(s.deadline)}`}
      </h3>

      <ol className="walk-list">
        {upcoming.map((o, i) => (
          <li key={o.cacheId} className="walk-list__item">
            <span className="walk-list__n">{i + 1}</span>
            <span className="walk-list__what">
              <strong>{o.code}</strong> {o.name}
              <small className="muted">
                {o.type} · arrive {hhmm(o.arriveAt)}
              </small>
            </span>
            {s.lockedNextId === o.cacheId ? (
              <button
                type="button"
                className="link-button"
                onClick={() => walk.lockNext(null)}
              >
                Unlock
              </button>
            ) : (
              i > 0 && (
                <button
                  type="button"
                  className="link-button"
                  disabled={!online || checking !== null}
                  onClick={() => void goHereNext(o.cacheId)}
                >
                  {checking === o.cacheId ? "Checking…" : "Go here next"}
                </button>
              )
            )}
          </li>
        ))}
      </ol>
      {upcoming.length === 0 && s.plan && (
        <p className="muted">No more caches fit before your back-by time.</p>
      )}

      {s.log.length > 0 && (
        <>
          <h4 className="walk-subheading">Done</h4>
          <ul className="walk-log">
            {s.log.map((l) => (
              <li key={l.cacheId}>
                {MARK[l.outcome]} ·{" "}
                {s.knownStops[l.cacheId]?.code ?? `#${l.cacheId}`}{" "}
                {s.knownStops[l.cacheId]?.name ?? ""} · {hhmm(l.at)}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="walk-actions">
        {visits > 0 && (
          <button
            type="button"
            className="walk-btn walk-btn--primary"
            disabled={!online || save.isPending}
            title={online ? undefined : "Saving needs a connection."}
            onClick={() => save.mutate()}
          >
            <Flag size={16} aria-hidden="true" /> Save as tour & end
          </button>
        )}
        <button
          type="button"
          className="walk-btn"
          onClick={() => {
            if (
              visits === 0 ||
              window.confirm("End the walk without saving it?")
            ) {
              walk.end();
            }
          }}
        >
          End walk
        </button>
      </div>
      {save.isError && (
        <p className="auth-error" role="alert">
          Couldn&rsquo;t save the walk — try again.
        </p>
      )}
    </div>
  );
}
