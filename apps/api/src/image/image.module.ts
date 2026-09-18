/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { ImageAdmissionService } from './services/image-admission.service'

// The catalog's own module. It exports the admission gate, which the box
// creation path is the only caller of today. The three entities are not
// registered here yet: nothing queries them until the registrar lands, and a
// `forFeature` for repositories no one injects would only look like they were
// in use.
@Module({
  providers: [ImageAdmissionService],
  exports: [ImageAdmissionService],
})
export class ImageModule {}
