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
 * What the caller of an operation decides about it: who started it and, for the
 * platform, why. Callers pass it explicitly; build one with the factories, which
 * allow a reason only on a platform context and an actor only on a person's.
 */
export class Context {
  private constructor(
    readonly actorKind: ActorKind,
    readonly reason?: PlatformReason,
    readonly actor?: RequestActor,
  ) {}

  static user(actor?: RequestActor): Context {
    return new Context(ActorKind.USER, undefined, actor)
  }

  static admin(actor?: RequestActor): Context {
    return new Context(ActorKind.ADMIN, undefined, actor)
  }

  static platform(reason: PlatformReason): Context {
    return new Context(ActorKind.PLATFORM, reason)
  }
}
