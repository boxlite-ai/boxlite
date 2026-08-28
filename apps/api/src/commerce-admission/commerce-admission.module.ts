/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { CommerceAdmissionService } from './commerce-admission.service'

@Module({
  providers: [CommerceAdmissionService],
  exports: [CommerceAdmissionService],
})
export class CommerceAdmissionModule {}
