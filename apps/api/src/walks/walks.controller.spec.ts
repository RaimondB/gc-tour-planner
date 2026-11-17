// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { WalksController } from "./walks.controller.js";
import type { WalksService } from "./walks.service.js";

describe("WalksController (ADR-0037 amendment)", () => {
  it("rejects a bad body without echoing it — it carries the position", async () => {
    const service = { replan: vi.fn() } as unknown as WalksService;
    const controller = new WalksController(service);
    const body = { position: [5.123456, 52.098765], returnPoint: "nope" };

    const err = await controller
      .replan({ id: "u1" } as never, body)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    const text = JSON.stringify((err as BadRequestException).getResponse());
    expect(text).not.toContain("5.123456");
    expect(text).not.toContain("52.098765");
    expect(service.replan).not.toHaveBeenCalled();
  });
});
