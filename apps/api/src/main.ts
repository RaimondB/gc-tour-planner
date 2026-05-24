// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

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
