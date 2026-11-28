/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Counter, metrics, trace } from '@opentelemetry/api'

let counter: Counter | undefined

export function recordApiModuleCacheAccess(cache: string, result: 'hit' | 'miss' | 'bypass'): void {
  counter ??= metrics.getMeter('').createCounter('api_module_cache_access', {
    description: 'API metadata and runner authentication cache accesses',
  })
  counter.add(1, { cache, result })
  trace.getActiveSpan()?.setAttributes({ 'cache.name': cache, 'cache.result': result })
}
