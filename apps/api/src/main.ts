// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import "reflect-metadata";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter.js";
import { ExpressAdapter } from "@bull-board/express";
import { getQueueToken } from "@nestjs/bullmq";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { Queue } from "bullmq";
import { AppModule } from "./app.module.js";
import { QUEUE_WALKING_PRECOMPUTE } from "./queues/queue.tokens.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  // Fire OnModuleDestroy on SIGTERM/SIGINT so the ComputePool drains its
  // worker threads cleanly instead of being hard-killed mid-task (ADR-0014).
  app.enableShutdownHooks();

  // CORS: opt-in via env. The dev setup proxies the API through Vite (same
  // origin), so CORS is unnecessary there. Production deploys that put the
  // web bundle on a different origin set `CORS_ORIGINS=https://app.example.com`
  // (comma-separated, no wildcards — credentials would break with `*`).
  const corsOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (corsOrigins.length > 0) {
    app.enableCors({
      origin: corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    });
  }

  const config = new DocumentBuilder()
    .setTitle("gc-tour-planner API")
    .setDescription(
      "Plan closed-loop geocaching tours from filtered cache clusters.",
    )
    .setVersion("0.0.0")
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("docs/api", app, document);

  // Bull-Board: operator queue dashboard. Mounted on the underlying
  // Express instance so it shares the same HTTP server (no separate port,
  // no second TLS terminator). Reads the queues by their Nest DI tokens
  // so we get the live BullMQ Queue instances — same connection as the
  // workers.
  //
  // Asset URLs are baked from `setBasePath` — they need to match the
  // PUBLIC URL path, not the in-container path. In UAT, the web nginx strips
  // `/api` before forwarding, so the browser is at
  // `<app-host>/api/admin/queues` while the container sees
  // `/admin/queues`. Set `BULL_BOARD_BASE_PATH=/api/admin/queues` in
  // the UAT compose env. Dev uses the default `/admin/queues` (api is
  // direct at localhost:3030).
  const queuesMountPath = "/admin/queues";
  const publicBasePath =
    process.env.BULL_BOARD_BASE_PATH ?? queuesMountPath;
  const walkingQueue = app.get<Queue>(getQueueToken(QUEUE_WALKING_PRECOMPUTE));
  const bullBoardAdapter = new ExpressAdapter();
  bullBoardAdapter.setBasePath(publicBasePath);
  createBullBoard({
    queues: [new BullMQAdapter(walkingQueue)],
    serverAdapter: bullBoardAdapter,
  });
  app.use(queuesMountPath, bullBoardAdapter.getRouter());

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  console.warn(
    `[api] listening on :${port} (OpenAPI at /docs/api, queues at ${publicBasePath})`,
  );
}

void bootstrap();
