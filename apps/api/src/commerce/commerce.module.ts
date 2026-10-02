/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { CommerceInternalClient } from './commerce-internal.client'

@Module({
  providers: [CommerceInternalClient],
  exports: [CommerceInternalClient],
})
export class CommerceModule {}
