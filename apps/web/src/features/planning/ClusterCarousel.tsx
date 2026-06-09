// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useRef, useState, type JSX } from "react";
import type { ClusterCandidate } from "@gctp/shared/tours";

export interface ClusterCarouselProps {
  clusters: ClusterCandidate[];
  chosenClusterId: string | null;
  focusedClusterId: string | null;
  /** Frame + pick a cluster (tap a card, or swipe one to centre). */
  onPick: (cluster: ClusterCandidate) => void;
  /** Hover a card → emphasize on the map (no camera move). */
  onFocus: (id: string | null) => void;
  avgWalkingKmh: number;
  timePerCacheMinutes: number;
}

/**
 * Compact, swipeable picker for the candidate clusters — lives in the
 * "Pick a cluster" peek so the cards + the Plan button are the default drawer
 * view. Native horizontal scroll-snap drives the swipe (reliable finger
 * input); the card that settles in the centre is framed + picked. Each card is
 * a single-line stat button with a details toggle tucked behind an info icon.
 */
export function ClusterCarousel({
  clusters,
  chosenClusterId,
  focusedClusterId,
  onPick,
  onFocus,
  avgWalkingKmh,
  timePerCacheMinutes,
}: ClusterCarouselProps): JSX.Element {
  const railRef = useRef<HTMLDivElement | null>(null);
  const swipeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onScroll = () => {
    // Swipe-to-frame is the mobile (horizontal carousel) interaction only. On
    // desktop the cards are a vertical list — picking is a click, and vertical
    // scroll must not re-frame.
    if (!window.matchMedia("(max-width: 768px)").matches) return;
    if (swipeTimer.current) clearTimeout(swipeTimer.current);
    swipeTimer.current = setTimeout(() => {
      const rail = railRef.current;
      if (!rail) return;
      const mid = rail.scrollLeft + rail.clientWidth / 2;
      let bestIdx = -1;
      let bestDist = Infinity;
      rail.querySelectorAll<HTMLElement>(".cluster-card").forEach((card, i) => {
        const c = card.offsetLeft + card.offsetWidth / 2;
        const d = Math.abs(c - mid);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      });
      const cluster = bestIdx >= 0 ? clusters[bestIdx] : undefined;
      if (cluster && cluster.clusterId !== chosenClusterId) onPick(cluster);
    }, 150);
  };

  return (
    <div
      className="cluster-carousel"
      ref={railRef}
      onScroll={onScroll}
      role="listbox"
      aria-label="Candidate clusters"
    >
      {clusters.map((c, i) => (
        <ClusterCard
          key={c.clusterId}
          cluster={c}
          rank={i + 1}
          picked={c.clusterId === chosenClusterId}
          focused={c.clusterId === focusedClusterId}
          onPick={onPick}
          onFocus={onFocus}
          avgWalkingKmh={avgWalkingKmh}
          timePerCacheMinutes={timePerCacheMinutes}
        />
      ))}
    </div>
  );
}

function ClusterCard({
  cluster,
  rank,
  picked,
  focused,
  onPick,
  onFocus,
  avgWalkingKmh,
  timePerCacheMinutes,
}: {
  cluster: ClusterCandidate;
  rank: number;
  picked: boolean;
  focused: boolean;
  onPick: (cluster: ClusterCandidate) => void;
  onFocus: (id: string | null) => void;
  avgWalkingKmh: number;
  timePerCacheMinutes: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const loopKm =
    (cluster.estimatedTourMeters > 0
      ? cluster.estimatedTourMeters
      : cluster.mstLengthMeters * 2) / 1000;
  const totalMin =
    (avgWalkingKmh > 0 ? (loopKm / avgWalkingKmh) * 60 : 0) +
    timePerCacheMinutes * cluster.cacheIds.length;

  return (
    <div
      className={[
        "cluster-card",
        picked ? "picked" : "",
        focused ? "focused" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="option"
      aria-selected={picked}
      onMouseEnter={() => onFocus(cluster.clusterId)}
    >
      <div className="cluster-card__row">
        <button
          type="button"
          className="cluster-card__main"
          onClick={() => onPick(cluster)}
        >
          <span className="cluster-card__rank">#{rank}</span>
          <span className="cluster-card__stat">
            <strong>{cluster.cacheIds.length} caches</strong> · ~
            {loopKm.toFixed(1)} km · ~{minutes(totalMin)}
          </span>
        </button>
        <button
          type="button"
          className="cluster-card__info"
          aria-label="Cluster details"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          ⓘ
        </button>
      </div>
      {open && (
        <div className="cluster-card__details">
          <span className="chip">
            MST {(cluster.mstLengthMeters / 1000).toFixed(2)} km
          </span>
          {cluster.estimatedTourMeters > 0 && (
            <span className="chip">
              est. {(cluster.estimatedTourMeters / 1000).toFixed(1)} km
            </span>
          )}
          <span className="chip">score {cluster.score.toFixed(3)}</span>
          {Object.entries(cluster.scoreBreakdown).map(([k, v]) => (
            <span key={k} className="chip">
              {k}: {v.toFixed(2)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function minutes(m: number): string {
  if (!Number.isFinite(m) || m < 0) return "—";
  const h = Math.floor(m / 60);
  const mm = Math.round(m - h * 60);
  if (h === 0) return `${mm} min`;
  return `${h} h ${mm.toString().padStart(2, "0")} min`;
}
