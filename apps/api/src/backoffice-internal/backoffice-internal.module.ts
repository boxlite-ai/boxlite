/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { BackofficeInternalController } from './backoffice-internal.controller'
import { BackofficeWorkloadAuthenticator, BackofficeWorkloadAuthGuard } from './backoffice-workload-auth'

@Module({
  controllers: [BackofficeInternalController],
  providers: [BackofficeWorkloadAuthenticator, BackofficeWorkloadAuthGuard],
})
export class BackofficeInternalModule {}
