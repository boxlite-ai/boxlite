/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Box } from '../box/entities/box.entity'
import { TypedConfigService } from '../config/typed-config.service'
import { OrganizationModule } from '../organization/organization.module'
import { RegistriesController } from './controllers/registries.controller'
import { RunnerRegistryCredentialController } from './controllers/runner-registry-credential.controller'
import { RegistryCredential } from './entities/registry-credential.entity'
import { RegistriesService, SECRET_STORE } from './services/registries.service'
import { RegistryCredentialService } from './services/registry-credential.service'
import { createSecretStore } from './stores/secret.store'

// Private registry credentials: which login applies to a repository, and the
// route the registry proxy asks that through. The entity is registered here
// because the app uses `autoLoadEntities`. `Box` is borrowed, not the box
// module, to ask whether a runner hosts an organization's box. The secret
// store is built once, at boot, which is where a misconfigured one — the file
// store in production among them — stops the API. `OrganizationModule` is
// imported for the permission guard the tenant routes run.
@Module({
  imports: [OrganizationModule, TypeOrmModule.forFeature([RegistryCredential, Box])],
  controllers: [RegistriesController, RunnerRegistryCredentialController],
  providers: [
    RegistryCredentialService,
    RegistriesService,
    { provide: SECRET_STORE, useFactory: createSecretStore, inject: [TypedConfigService] },
  ],
  exports: [RegistryCredentialService],
})
export class RegistryModule {}
