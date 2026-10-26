/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import { Request } from 'express'
import { CustomHeaders } from '../constants/header.constants'
import { Context, RequestActor } from '../context/context'
import { AuthContextType, isAuthContext } from '../interfaces/auth-context.interface'

// Spec builds load no passport types, so the user an auth guard attaches is declared here.
type RequestWithUser = Request & {
  user?: AuthContextType
}

// Client labels are logged as sent, so only a short plain token is kept.
const CLIENT_LABEL = /^[\w.+/ -]{1,64}$/

function clientLabel(request: Request, header: string): string | undefined {
  const value = request.get(header)
  return value && CLIENT_LABEL.test(value) ? value : undefined
}

/** The person behind an authenticated request; undefined for service callers such as the proxy or a runner. */
export function requestActor(request: Request): RequestActor | undefined {
  const user = (request as RequestWithUser).user
  if (!user || !isAuthContext(user)) {
    return undefined
  }
  return {
    userId: user.userId,
    authMethod: user.apiKey ? 'api_key' : 'jwt',
    clientSource: clientLabel(request, CustomHeaders.SOURCE.name),
    sdkVersion: clientLabel(request, CustomHeaders.SDK_VERSION.name),
  }
}

/** A user context for the request's operation, naming who acted and how they called. */
export const UserContext = createParamDecorator((_data: unknown, ctx: ExecutionContext): Context =>
  Context.user(requestActor(ctx.switchToHttp().getRequest<Request>())),
)
