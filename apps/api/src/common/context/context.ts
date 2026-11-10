/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ActorKind } from './actor-kind.enum'
import { PlatformReason } from './platform-reason.enum'

/**
 * Who started an operation and, for platform callers, its reason and optional
 * database lock-wait budget. Callers pass it explicitly using these factories.
 */
export class Context {
  private constructor(
    readonly actorKind: ActorKind,
    readonly reason?: PlatformReason,
    readonly lockTimeoutMs?: number,
  ) {}

  static user(): Context {
    return new Context(ActorKind.USER)
  }

  static admin(): Context {
    return new Context(ActorKind.ADMIN)
  }

  static platform(reason: PlatformReason, options: { lockTimeoutMs?: number } = {}): Context {
    return new Context(ActorKind.PLATFORM, reason, options.lockTimeoutMs)
  }
}
