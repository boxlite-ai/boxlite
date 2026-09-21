/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Box } from '../box/entities/box.entity'
import { OrganizationModule } from '../organization/organization.module'
import { ImageController } from './controllers/image.controller'
import { Image } from './entities/image.entity'
import { ImageTag } from './entities/image-tag.entity'
import { ImageVersion } from './entities/image-version.entity'
import { CuratedImagePinService } from './services/curated-image-pin.service'
import { ImageAdmissionService } from './services/image-admission.service'
import { ImageCatalogService } from './services/image-catalog.service'
import { ImagePreparationService } from './services/image-preparation.service'
import { ImageRegistrarService } from './services/image-registrar.service'
import { ImageResolverService } from './services/image-resolver.service'

// The catalog's own module: the gate that decides whether an image may be
// used at all, the resolver that turns it into the ref a runner is given, the
// registrar that records what that ref turned out to be — in the catalog for a
// tenant's image, as a per-runner pin for a curated one — the catalog the four
// HTTP routes read, and the preparation service that says whether a box is
// still waiting on a first pull. The entities are registered here because the
// app uses `autoLoadEntities` — this `forFeature` is what makes the tables
// mapped at runtime. `Box` is in it because removing an image has to know
// whether a box could still boot from it; only the entity is borrowed, not
// the box module. `OrganizationModule` is imported for the permission guard
// the controller runs, which resolves the caller's role. It does not import
// this module back, so the edge BoxModule → ImageModule → OrganizationModule
// stays acyclic.
@Module({
  imports: [OrganizationModule, TypeOrmModule.forFeature([Image, ImageVersion, ImageTag, Box])],
  controllers: [ImageController],
  providers: [
    ImageAdmissionService,
    ImageCatalogService,
    ImagePreparationService,
    ImageRegistrarService,
    ImageResolverService,
    CuratedImagePinService,
  ],
  exports: [
    ImageAdmissionService,
    ImagePreparationService,
    ImageRegistrarService,
    ImageResolverService,
    CuratedImagePinService,
  ],
})
export class ImageModule {}
