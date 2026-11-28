/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function copyEntity<T>(entity: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(entity)), structuredClone(entity)) as T
}
