// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

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

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  console.warn(`[api] listening on :${port} (OpenAPI at /docs/api)`);
}

void bootstrap();
