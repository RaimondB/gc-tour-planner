// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { BullModule } from "@nestjs/bullmq";
import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  QUEUE_LANDUSE_REPLICATION,
  QUEUE_WALKING_PRECOMPUTE,
} from "./queue.tokens.js";

/**
 * Shared BullMQ wiring. Producers (admin controller, gpx upload service)
 * and consumers (worker processors) both import this module so the queue
 * names and Valkey connection are defined exactly once.
 *
 * `@Global()` because the queue tokens are injected from many feature
 * modules and we don't want to re-import this in each one.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>("VALKEY_URL");
        if (!url) {
          throw new Error(
            "VALKEY_URL is not set. See infra/.env.example. " +
              "Valkey backs the BullMQ queues for upload-triggered precompute.",
          );
        }
        return {
          // BullMQ accepts either a connection string or an options object;
          // the string keeps host/port/db logic out of code (e.g. swapping in
          // an ACL-scoped URL for prod).
          connection: { url },
        };
      },
    }),
    BullModule.registerQueue(
      {
        name: QUEUE_WALKING_PRECOMPUTE,
        defaultJobOptions: {
          // Failed jobs stay around for the operator dashboard's failed-list.
          // Successful jobs are purged so the dashboard doesn't fill with
          // green noise from steady-state operations.
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 7 * 24 * 3600 },
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      },
      {
        name: QUEUE_LANDUSE_REPLICATION,
        defaultJobOptions: {
          removeOnComplete: { age: 7 * 24 * 3600, count: 100 },
          removeOnFail: { age: 30 * 24 * 3600 },
          // Replication is daily and idempotent; on transient failure
          // retry twice over a few minutes before giving up (operator
          // can manually retrigger via /admin/landuse/reimport).
          attempts: 3,
          backoff: { type: "exponential", delay: 60_000 },
        },
      },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
