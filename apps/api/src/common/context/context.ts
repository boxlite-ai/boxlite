/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ActorKind } from './actor-kind.enum'
import { PlatformReason } from './platform-reason.enum'

/**
 * What the caller of an operation decides about it: who started it and, for the
 * platform, why. Callers pass it explicitly; build one with the factories, which
 * allow a reason only on a platform context.
 */
export class Context {
  private constructor(
    readonly actorKind: ActorKind,
    readonly reason?: PlatformReason,
  ) {}

  static user(): Context {
    return new Context(ActorKind.USER)
  }

  static admin(): Context {
    return new Context(ActorKind.ADMIN)
  }

  static platform(reason: PlatformReason): Context {
    return new Context(ActorKind.PLATFORM, reason)
  }
}
