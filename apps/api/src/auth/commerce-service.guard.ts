/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, ExecutionContext, Logger, CanActivate } from '@nestjs/common'
import { getAuthContext } from './get-auth-context'
import { isCommerceServiceContext } from '../common/interfaces/commerce-service-context.interface'

@Injectable()
export class CommerceServiceGuard implements CanActivate {
  protected readonly logger = new Logger(CommerceServiceGuard.name)

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Throws if not the commerce-rs service context
    getAuthContext(context, isCommerceServiceContext)
    return true
  }
}
