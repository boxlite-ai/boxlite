/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Box } from '../box/entities/box.entity'
import { RunnerRegistryCredentialController } from './controllers/runner-registry-credential.controller'
import { RegistryCredential } from './entities/registry-credential.entity'
import { RegistryCredentialService } from './services/registry-credential.service'

// Private registry credentials: which login applies to a repository, and the
// route the registry proxy asks that through. The entity is registered here
// because the app uses `autoLoadEntities`. `Box` is borrowed, not the box
// module, to ask whether a runner hosts an organization's box.
@Module({
  imports: [TypeOrmModule.forFeature([RegistryCredential, Box])],
  controllers: [RunnerRegistryCredentialController],
  providers: [RegistryCredentialService],
  exports: [RegistryCredentialService],
})
export class RegistryModule {}
