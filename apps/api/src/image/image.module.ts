/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Image } from './entities/image.entity'
import { ImageTag } from './entities/image-tag.entity'
import { ImageVersion } from './entities/image-version.entity'
import { ImageAdmissionService } from './services/image-admission.service'
import { ImageRegistrarService } from './services/image-registrar.service'
import { ImageResolverService } from './services/image-resolver.service'

// The catalog's own module: the gate that decides whether an image may be used
// at all, the resolver that turns it into the ref a runner is given, and the
// registrar that records what that ref turned out to be. The entities are
// registered here because the app uses `autoLoadEntities` — this `forFeature`
// is what makes the three tables mapped at runtime.
@Module({
  imports: [TypeOrmModule.forFeature([Image, ImageVersion, ImageTag])],
  providers: [ImageAdmissionService, ImageRegistrarService, ImageResolverService],
  exports: [ImageAdmissionService, ImageRegistrarService, ImageResolverService],
})
export class ImageModule {}
