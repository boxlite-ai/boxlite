/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { Audit, TypedRequest } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RegistryCredential } from '../registry/entities/registry-credential.entity'
import { RegistriesService } from '../registry/services/registries.service'
import { CreateRegistryDto } from './dto/create-registry.dto'

type RestRegistryCredential = {
  id: string
  registry_host: string
  repository_prefix: string
  username: string
  created_by: string | null
  created_at: string
}

/**
 * Registry logins on the box API, where an SDK's `rt.registries()` manages them.
 *
 * The console manages the same logins through `/api/registries`
 * (`registries.controller.ts`); this answers in the box API's snake_case
 * shapes (`openapi/box.openapi.yaml`), on the same permissions and with the
 * same audit records. Neither an answer nor a record carries the password.
 */
@Controller(['v1/registries', 'v1/:prefix/registries'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
export class BoxliteRegistryController {
  constructor(private readonly registries: RegistriesService) {}

  @Get()
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_REGISTRIES])
  async list(@AuthContext() authContext: OrganizationAuthContext): Promise<{ registries: RestRegistryCredential[] }> {
    const credentials = await this.registries.list(authContext.organizationId)
    return { registries: credentials.map(toRestCredential) }
  }

  @Post()
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_REGISTRIES])
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.REGISTRY_CREDENTIAL,
    targetIdFromResult: (result: RestRegistryCredential) => result?.id,
    requestMetadata: {
      // Named fields, never the body: the body carries the password.
      body: (req: TypedRequest<CreateRegistryDto>) => ({
        registry_host: req.body?.registry_host,
        repository_prefix: req.body?.repository_prefix,
        username: req.body?.username,
      }),
    },
  })
  async create(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() request: CreateRegistryDto,
  ): Promise<RestRegistryCredential> {
    const created = await this.registries.create(authContext.organizationId, authContext.userId ?? null, {
      registryHost: request.registry_host,
      repositoryPrefix: request.repository_prefix,
      username: request.username,
      password: request.password,
    })
    return toRestCredential(created)
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_REGISTRIES])
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.REGISTRY_CREDENTIAL,
    targetIdFromRequest: (req) => req.params.id,
  })
  async remove(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.registries.delete(authContext.organizationId, id)
  }
}

function toRestCredential(credential: RegistryCredential): RestRegistryCredential {
  return {
    id: credential.id,
    registry_host: credential.registryHost,
    repository_prefix: credential.repositoryPrefix,
    username: credential.username,
    created_by: credential.createdBy,
    created_at: credential.createdAt.toISOString(),
  }
}
