/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Where the bytes came from. Only `pull` exists while images are fetched from
// upstream registries; the builder adds `build` when it lands.
export enum ImageSourceKind {
  PULL = 'pull',
}
