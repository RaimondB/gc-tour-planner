// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import "reflect-metadata";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { getQueueToken } from "@nestjs/bullmq";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { Queue } from "bullmq";
import cookieParser from "cookie-parser";
import { raw, type RequestHandler } from "express";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { parseTrustProxy } from "./auth/client-ip.js";
import { SESSION_COOKIE } from "./auth/cookies.js";
import { SessionService } from "./auth/session.service.js";
import { QUEUE_WALKING_PRECOMPUTE } from "./queues/queue.tokens.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  // Fire OnModuleDestroy on SIGTERM/SIGINT so the ComputePool drains its
  // worker threads cleanly instead of being hard-killed mid-task (ADR-0014).
  app.enableShutdownHooks();

  // The app sits behind nginx (and, in prod, the Cloudflare tunnel), so the
  // socket peer is the proxy, not the client. Trust the proxy so `req.ip` and
  // the rate-limit tracker resolve to the real client (FR-P9, Gate 1.1).
  // Default trusts the single immediate hop (nginx); nginx appends the true
  // peer to X-Forwarded-For, so an inbound spoofed XFF cannot win.
  app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));

  // Security headers (M6, ADR-0021). `crossOriginResourcePolicy` is relaxed so
  // the API can be consumed from the web origin in split-origin deploys (CORS
  // is configured separately below). cookie-parser populates `req.cookies`,
  // which the auth guard reads for the session + CSRF tokens.
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cookieParser());

  // Buffer raw image/webp bodies (the saved-tour map snapshot, PUT
  // /tours/:id/preview). The filter means this parser only touches image/webp
  // requests — every JSON route is untouched and still parsed by Nest. The 1 MB
  // limit is a backstop; the controller enforces the real 512 KB cap.
  app.use(raw({ type: "image/webp", limit: "1mb" }));

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
  const publicBasePath = process.env.BULL_BOARD_BASE_PATH ?? queuesMountPath;
  const walkingQueue = app.get<Queue>(getQueueToken(QUEUE_WALKING_PRECOMPUTE));
  const bullBoardAdapter = new ExpressAdapter();
  bullBoardAdapter.setBasePath(publicBasePath);
  createBullBoard({
    queues: [new BullMQAdapter(walkingQueue)],
    serverAdapter: bullBoardAdapter,
  });

  // Bull-board is raw Express middleware mounted OUTSIDE Nest's routing, so the
  // global JwtAuthGuard never runs for it — without this gate the queue
  // dashboard (and its mutating retry/remove actions) would be reachable with no
  // auth at all. Require an admin session, mirroring AdminGuard (FR-P12).
  const sessions = app.get(SessionService, { strict: false });
  const requireAdminSession: RequestHandler = (req, res, next) => {
    const sid = (req.cookies as Record<string, string> | undefined)?.[
      SESSION_COOKIE
    ];
    void (async () => {
      const session = sid ? await sessions.get(sid) : null;
      if (!session) {
        res.status(401).json({ message: "Not authenticated" });
      } else if (session.isAdmin !== true) {
        res.status(403).json({ message: "Admin role required" });
      } else {
        next();
      }
    })().catch(next);
  };
  app.use(queuesMountPath, requireAdminSession, bullBoardAdapter.getRouter());

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  console.warn(
    `[api] listening on :${port} (OpenAPI at /docs/api, queues at ${publicBasePath})`,
  );
}

void bootstrap();
