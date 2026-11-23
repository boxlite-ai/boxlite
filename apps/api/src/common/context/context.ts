/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ActorKind } from './actor-kind.enum'
import { PlatformReason } from './platform-reason.enum'

/** The person behind a request, and how and from where they called. */
export interface RequestActor {
  userId: string
  authMethod: 'api_key' | 'jwt'
  clientSource?: string
  sdkVersion?: string
}

/**
 * Who started an operation, including a person's identity or a platform reason
 * and optional database lock-wait budget. Callers use the explicit factories.
 */
export class Context {
  private constructor(
    readonly actorKind: ActorKind,
    readonly reason?: PlatformReason,
    readonly actor?: RequestActor,
    readonly lockTimeoutMs?: number,
  ) {}

  static user(actor?: RequestActor): Context {
    return new Context(ActorKind.USER, undefined, actor)
  }

  static admin(actor?: RequestActor): Context {
    return new Context(ActorKind.ADMIN, undefined, actor)
  }

  static platform(reason: PlatformReason, options: { lockTimeoutMs?: number } = {}): Context {
    return new Context(ActorKind.PLATFORM, reason, undefined, options.lockTimeoutMs)
  }
}
