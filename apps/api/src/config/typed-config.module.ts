/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpModule } from '@nestjs/axios'
import { Global, Module, DynamicModule } from '@nestjs/common'
import { ConfigModule as NestConfigModule, ConfigModuleOptions } from '@nestjs/config'
import { TypedConfigService } from './typed-config.service'
import { configuration } from './configuration'
import { ConfigController } from './config.controller'
import { OidcMetadataService } from './oidc-metadata.service'

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      load: [() => configuration],
    }),
    HttpModule,
  ],
  controllers: [ConfigController],
  providers: [TypedConfigService, OidcMetadataService],
  exports: [TypedConfigService, OidcMetadataService],
})
export class TypedConfigModule {
  static forRoot(options: Partial<ConfigModuleOptions> = {}): DynamicModule {
    return {
      module: TypedConfigModule,
      imports: [
        NestConfigModule.forRoot({
          ...options,
        }),
        HttpModule,
      ],
      providers: [TypedConfigService, OidcMetadataService],
      exports: [TypedConfigService, OidcMetadataService],
    }
  }
}
