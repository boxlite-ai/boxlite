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
import { ImageResolverService } from './services/image-resolver.service'

// The catalog's own module: the gate that decides whether an image may be used
// at all, and the resolver that turns it into the ref a runner is given. The
// entities are registered here because the resolver queries them — the app uses
// `autoLoadEntities`, so this is what makes the three tables mapped at runtime.
@Module({
  imports: [TypeOrmModule.forFeature([Image, ImageVersion, ImageTag])],
  providers: [ImageAdmissionService, ImageResolverService],
  exports: [ImageAdmissionService, ImageResolverService],
})
export class ImageModule {}
