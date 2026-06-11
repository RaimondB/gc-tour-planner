// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { LngLat } from "../geo/index.js";
import { ClusterCandidate } from "./cluster-candidate.js";
import { ClusteringStrategyName, HardFilters } from "./plan-input.js";

/**
 * Input for `POST /tours/clusters/explain` — analyse an arbitrary cache set
 * in the same context as a normal planning request. Used both for:
 *
 *  1. Manual cluster selection: "why didn't the algorithm produce this set?"
 *  2. Adapting a candidate cluster: "why was this cache included?"
 *
 * The server doesn't care about provenance — both reduce to "diagnose this
 * cache id list against the same walking graph the planner would build."
 */
export const ExplainClusterInput = z.object({
  center: LngLat,
  radiusM: z.number().int().positive().max(50_000),
  hardFilters: HardFilters,
  maxLinkMeters: z.number().int().min(200).max(5_000).default(1_500),
  minClusterSize: z.number().int().min(2).max(50).default(8),
  distanceBudgetMeters: z.number().int().positive().max(25_000).default(8_000),
  /** Optional — used to populate `algorithmAttribution` with the chosen strategy's actual run. */
  clusteringStrategy: ClusteringStrategyName.optional(),
  /** Cache ids to analyse. Must all be in the user's pool (uploaded GPX). */
  cacheIds: z.array(z.number().int().positive()).min(2).max(50),
});
export type ExplainClusterInput = z.infer<typeof ExplainClusterInput>;

const ExplainCache = z.object({
  id: z.number().int().positive(),
  code: z.string(),
  name: z.string(),
  lng: z.number(),
  lat: z.number(),
  /** Did this cache pass `hardFilters` and survive the candidate-pool cap? */
  inCandidatePool: z.boolean(),
  /** Top-K nearest neighbours by haversine, with OSRM-walking distances when available. */
  nearestKnnInPool: z.array(
    z.object({
      id: z.number().int().positive(),
      haversineM: z.number().nonnegative(),
      walkingM: z.number().nonnegative().nullable(),
      walkingS: z.number().nonnegative().nullable(),
    }),
  ),
});
export type ExplainCache = z.infer<typeof ExplainCache>;

const ExplainEdge = z.object({
  a: z.number().int().positive(),
  b: z.number().int().positive(),
  haversineM: z.number().nonnegative(),
  /** OSRM walking length; null if OSRM couldn't connect the pair. */
  walkingM: z.number().nonnegative().nullable(),
  walkingS: z.number().nonnegative().nullable(),
  /** True if the symmetric pair survived the sparse k-NN graph. */
  inWalkingGraph: z.boolean(),
  /** True if `walkingM` (or fallback haversine) is ≤ `maxLinkMeters`. */
  withinMaxLink: z.boolean(),
});
export type ExplainEdge = z.infer<typeof ExplainEdge>;

const StrategyOutcome = z.object({
  /**
   * Partition of the selection produced by running this strategy *restricted
   * to the selection's induced subgraph*. Each inner array is one cluster.
   * "Noise" (singletons / dropped) ends up in the `noise` array when the
   * strategy distinguishes them; otherwise they form 1-element clusters.
   */
  clustersWithinSelection: z.array(z.array(z.number().int().positive())),
  /** Caches the strategy labelled as noise (DBSCAN/HDBSCAN); empty for others. */
  noise: z.array(z.number().int().positive()),
  /** Strategy-specific knobs used (echoed for the JSON dump). */
  params: z.record(z.string(), z.union([z.number(), z.string()])),
});
export type StrategyOutcome = z.infer<typeof StrategyOutcome>;

const RefinementStageReport = z.object({
  wouldDrop: z.array(z.number().int().positive()),
});

export const ExplainClusterResponse = z.object({
  selection: z.object({
    cacheIds: z.array(z.number().int().positive()),
    boundingDiameterM: z.number().nonnegative(),
    medianPairwiseM: z.number().nonnegative(),
    /** MST × 2 lower bound on a closed-loop walk over the selection. */
    walkingLoopLowerBoundM: z.number().nonnegative(),
    withinBudget: z.boolean(),
    /** Cluster-scoring breakdown for the whole selection. */
    score: z.object({
      total: z.number(),
      breakdown: z.record(z.string(), z.number()),
    }),
  }),
  caches: z.array(ExplainCache),
  edges: z.array(ExplainEdge),
  refinement: z.object({
    walkingOutlierTrim: RefinementStageReport,
    geographicOutlierTrim: RefinementStageReport.extend({
      centroid: LngLat,
      medianFromCentroidM: z.number().nonnegative(),
      capM: z.number().nonnegative(),
    }),
    mstCut: z.object({
      wouldSplitInto: z.array(z.array(z.number().int().positive())),
    }),
  }),
  perStrategy: z.object({
    louvain: StrategyOutcome,
    dbscan: StrategyOutcome,
    hdbscan: StrategyOutcome,
    "hdbscan-star": StrategyOutcome,
    components: StrategyOutcome,
  }),
  /**
   * For each strategy: the candidate cluster from the normal planner run that
   * best matches the selection (Jaccard). `matchedCandidate` is null when no
   * candidate overlapped meaningfully, which is the "why didn't this surface?"
   * smoking gun.
   */
  algorithmAttribution: z.array(
    z.object({
      strategy: ClusteringStrategyName,
      matchedCandidate: ClusterCandidate.nullable(),
      jaccard: z.number().min(0).max(1),
    }),
  ),
});
export type ExplainClusterResponse = z.infer<typeof ExplainClusterResponse>;
