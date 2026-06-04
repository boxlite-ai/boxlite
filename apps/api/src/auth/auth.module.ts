/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'
import { JwtStrategy } from './jwt.strategy'
import { ApiKeyStrategy } from './api-key.strategy'
import { UserModule } from '../user/user.module'
import { ApiKeyModule } from '../api-key/api-key.module'
import { SandboxModule } from '../sandbox/sandbox.module'
import { TypedConfigService } from '../config/typed-config.service'
import { UserService } from '../user/user.service'
import { TypedConfigModule } from '../config/typed-config.module'
import { OidcMetadataService } from '../config/oidc-metadata.service'
import { FailedAuthTrackerService } from './failed-auth-tracker.service'
import { RegionModule } from '../region/region.module'
import { LogoutController } from './logout.controller'
@Module({
  imports: [
    PassportModule.register({
      defaultStrategy: ['jwt', 'api-key'],
      property: 'user',
      session: false,
    }),
    TypedConfigModule,
    UserModule,
    ApiKeyModule,
    SandboxModule,
    RegionModule,
  ],
  controllers: [LogoutController],
  providers: [
    ApiKeyStrategy,
    {
      provide: JwtStrategy,
      useFactory: async (
        userService: UserService,
        oidcMetadataService: OidcMetadataService,
        configService: TypedConfigService,
      ) => {
        if (configService.get('skipConnections')) {
          return
        }

        const metadata = await oidcMetadataService.getMetadata()

        let jwksUri = metadata.jwks_uri

        const internalIssuer = configService.getOrThrow('oidc.issuer')
        const publicIssuer = configService.get('oidc.publicIssuer')
        if (publicIssuer) {
          // Replace localhost URLs with Docker network URLs for internal API use
          jwksUri = metadata.jwks_uri.replace(publicIssuer, internalIssuer)
        }
        return new JwtStrategy(
          {
            audience: configService.get('oidc.audience'),
            issuer: metadata.issuer,
            jwksUri: jwksUri,
          },
          userService,
          configService,
        )
      },
      inject: [UserService, OidcMetadataService, TypedConfigService],
    },
    FailedAuthTrackerService,
  ],
  exports: [PassportModule, JwtStrategy, ApiKeyStrategy, FailedAuthTrackerService],
})
export class AuthModule {}
