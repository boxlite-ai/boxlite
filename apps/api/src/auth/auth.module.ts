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
import { BoxModule } from '../box/box.module'
import { TypedConfigService } from '../config/typed-config.service'
import { UserService } from '../user/user.service'
import { TypedConfigModule } from '../config/typed-config.module'
import { OidcMetadataService } from '../config/oidc-metadata.service'
import { FailedAuthTrackerService } from './failed-auth-tracker.service'
import { LoginEventRecorder } from './login-event.recorder'
import { RegionModule } from '../region/region.module'
import { LogoutController } from './logout.controller'
import { AccountLinkController } from './account-link.controller'
import { AccountLinkService } from './account-link.service'
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
    BoxModule,
    RegionModule,
  ],
  controllers: [LogoutController, AccountLinkController],
  providers: [
    AccountLinkService,
    ApiKeyStrategy,
    {
      provide: JwtStrategy,
      useFactory: async (
        userService: UserService,
        oidcMetadataService: OidcMetadataService,
        configService: TypedConfigService,
        loginEvents: LoginEventRecorder,
      ) => {
        if (configService.get('skipConnections')) {
          return
        }

        const metadata = await oidcMetadataService.getMetadata()

        let jwksUri = metadata.jwks_uri

        const internalIssuer = configService.getOrThrow('oidc.issuer')
        const publicIssuer = configService.get('oidc.publicIssuer')
        if (publicIssuer) {
          // Keep JWKS reachable from the API container, while validating the
          // token issuer that browser clients actually receive.
          jwksUri = metadata.jwks_uri.replace(publicIssuer, internalIssuer)
        }
        return new JwtStrategy(
          {
            audience: configService.get('oidc.audience'),
            issuer: toPublicJwtIssuer(metadata.issuer, internalIssuer, publicIssuer),
            jwksUri: jwksUri,
          },
          userService,
          configService,
          loginEvents,
        )
      },
      inject: [UserService, OidcMetadataService, TypedConfigService, LoginEventRecorder],
    },
    FailedAuthTrackerService,
    LoginEventRecorder,
  ],
  exports: [PassportModule, JwtStrategy, ApiKeyStrategy, FailedAuthTrackerService],
})
export class AuthModule {}

function toPublicJwtIssuer(metadataIssuer: string, internalIssuer: string, publicIssuer?: string): string {
  if (!publicIssuer) {
    return metadataIssuer
  }

  const internalBase = stripTrailingSlashes(internalIssuer)
  const publicBase = stripTrailingSlashes(publicIssuer)

  if (metadataIssuer === internalBase) {
    return publicBase
  }
  if (metadataIssuer.startsWith(`${internalBase}/`)) {
    return `${publicBase}${metadataIssuer.substring(internalBase.length)}`
  }
  if (metadataIssuer === publicBase || metadataIssuer.startsWith(`${publicBase}/`)) {
    return metadataIssuer
  }

  return publicIssuer
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}
