/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { BusinessEventActorKind } from './business-event.util'

interface BusinessEventLogContext {
  actorKind: BusinessEventActorKind
}

const contextStorage = new AsyncLocalStorage<BusinessEventLogContext>()

/**
 * Runs fn with logContext as the context of the business events it records, so an
 * entry point (controller, auth strategy) states who asked without threading an
 * actor parameter through service signatures. The context follows fn's awaits.
 */
export function runWithLogContext<T>(logContext: BusinessEventLogContext, fn: () => T): T {
  return contextStorage.run(logContext, fn)
}

/** The context of the nearest enclosing runWithLogContext, or undefined outside one. */
export function currentLogContext(): BusinessEventLogContext | undefined {
  return contextStorage.getStore()
}
