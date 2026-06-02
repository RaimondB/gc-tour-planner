-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Custom OSRM foot profile for gc-tour-planner (ADR-0013).
--
-- The stock osrm-backend foot profile (/opt/foot.lua, BSD-2-Clause) omits
-- highway=cycleway from its walkable-highway speed table, so standalone
-- cycleways — extremely common in NL and usually walkable in practice — are
-- dropped from the foot graph entirely and tours detour onto parallel car
-- roads (and via-points can't recover, since there is no foot edge to snap
-- to). See ADR-0013.
--
-- Rather than vendoring the whole upstream profile (and pinning to its
-- version), we load it at runtime and patch a single entry: give cycleway
-- the same walking speed as footway. The stock access handler still runs,
-- so cycleways tagged foot=no / access=private remain excluded — we add the
-- quiet, walkable ones, not a blanket override.
--
-- Loaded via `-p /opt/foot-gctp.lua` (bind-mounted there). The stock profile
-- and its lib/ live in /opt in the osrm-backend image, so loadfile() and the
-- stock profile's own require('lib/..') calls resolve against /opt. See
-- infra/osrm/bootstrap.sh.

api_version = 2

local stock = assert(loadfile('/opt/foot.lua'))()

local original_setup = stock.setup
stock.setup = function()
  local profile = original_setup()
  -- footway already maps to walking_speed; reuse the value so we track
  -- whatever the upstream profile uses rather than hard-coding 5 km/h.
  profile.speeds.highway.cycleway = profile.speeds.highway.footway
  return profile
end

return stock
