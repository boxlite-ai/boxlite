/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Box } from '../box/entities/box.entity'
import { OrganizationModule } from '../organization/organization.module'
import { RegistryModule } from '../registry/registry.module'
import { RegistriesController } from '../registry/controllers/registries.controller'
import { ImageController } from './controllers/image.controller'
import { Image } from './entities/image.entity'
import { ImageAlias } from './entities/image-alias.entity'
import { ImageAliasEvent } from './entities/image-alias-event.entity'
import { ImageVersion } from './entities/image-version.entity'
import { CuratedImagePinService } from './services/curated-image-pin.service'
import { ImageAdmissionService } from './services/image-admission.service'
import { ImageCatalogService } from './services/image-catalog.service'
import { ImagePreparationService } from './services/image-preparation.service'
import { ImagePullFailureService } from './services/image-pull-failure.service'
import { ImageRegistrarService } from './services/image-registrar.service'
import { ImageResolverService } from './services/image-resolver.service'

// The catalog's own module: the gate that decides whether an image may be
// used at all, the resolver that turns it into the ref a runner is given, the
// registrar that records what that ref turned out to be — in the catalog for a
// tenant's image, as a per-runner pin for a curated one — the catalog the six
// HTTP routes read, which also creates and deletes aliases, the preparation service that says
// whether a box is still waiting on a first pull, and the service that explains
// a pull that failed and marks a version its registry no longer has. The
// entities are registered here because the app uses `autoLoadEntities` — this
// `forFeature` is what makes the tables mapped at runtime. `Box` is in it
// because removing an image has to know whether a box could still boot from it;
// only the entity is borrowed, not the box module. `RegistryModule` says
// whether an organization registered a login for a repository, which is what
// routes it through the registry proxy. `OrganizationModule` is imported for
// the permission guard the controller runs, which resolves the caller's role.
// It does not import this module back, so the edge BoxModule → ImageModule →
// OrganizationModule stays acyclic.
@Module({
  imports: [
    OrganizationModule,
    RegistryModule,
    TypeOrmModule.forFeature([Image, ImageVersion, ImageAlias, ImageAliasEvent, Box]),
  ],
  // The static nested resource must match before /images/:idOrRef.
  controllers: [RegistriesController, ImageController],
  providers: [
    ImageAdmissionService,
    ImageCatalogService,
    ImagePreparationService,
    ImagePullFailureService,
    ImageRegistrarService,
    ImageResolverService,
    CuratedImagePinService,
  ],
  exports: [
    ImageAdmissionService,
    ImageCatalogService,
    ImagePreparationService,
    ImagePullFailureService,
    ImageRegistrarService,
    ImageResolverService,
    CuratedImagePinService,
  ],
})
export class ImageModule {}
