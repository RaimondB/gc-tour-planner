// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Placeholder Kysely typings. M2 introduces real tables and replaces this
// file with codegen output. Until then we only declare an empty `Database`
// interface so application code can take a typed `Kysely<Database>` instance.

// Tables land here in M2 (caches, cache_attributes, additional_waypoints, ...).
// See docs/DESIGN.md §1. Using a type alias for now so an empty interface
// doesn't trip @typescript-eslint/no-empty-object-type.
export type Database = Record<string, never>;
