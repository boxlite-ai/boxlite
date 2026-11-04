import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { ApiKey } from '../api-key/api-key.entity'
import { ApiKeyService } from '../api-key/api-key.service'
import { Context } from '../common/context/context'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { principalStorage } from './engine/platform-principal'
import type { AppRow } from './engine/db'
import type { AppCredentials } from './engine/ctx'

@Injectable()
export class CloudAppCredentials implements AppCredentials {
  constructor(
    private readonly keys: ApiKeyService,
    private readonly database: DataSource,
    private readonly memberships: OrganizationUserService,
  ) {}

  async issue(app: AppRow): Promise<string> {
    const principal = principalStorage.getStore()
    if (!principal || principal.organizationId !== app.org_id || principal.appId)
      throw new ForbiddenException('A platform member must issue App credentials')
    const { value } = await this.keys.createApiKey(
      app.org_id,
      principal.userId,
      `app-${app.id}-${randomUUID()}`,
      [Permission.READ_APPS, Permission.WRITE_APPS],
      Context.user({ userId: principal.userId, authMethod: 'jwt' }),
      undefined,
      undefined,
      app.id,
    )
    return value
  }

  async list(app: AppRow) {
    const keys = await this.database
      .getRepository(ApiKey)
      .find({ where: { organizationId: app.org_id, cloudAppId: app.id } })
    return keys.map((key) => ({
      id: key.name,
      last4: key.keySuffix,
      created_at: key.createdAt.toISOString(),
      last_used_at: key.lastUsedAt?.toISOString() ?? null,
    }))
  }

  async revoke(app: AppRow, id: string): Promise<void> {
    const key = await this.database
      .getRepository(ApiKey)
      .findOne({ where: { organizationId: app.org_id, cloudAppId: app.id, name: id } })
    if (!key) throw new NotFoundException('App credential not found')
    await this.keys.deleteApiKey(key.organizationId, key.userId, key.name)
  }

  async rotate(app: AppRow): Promise<string> {
    const existing = await this.list(app)
    const value = await this.issue(app)
    for (const key of existing) await this.revoke(app, key.id)
    return value
  }

  async authenticate(token: string) {
    const key = await this.keys.getApiKeyByValue(token).catch((error) => {
      if (error instanceof NotFoundException) return null
      throw error
    })
    if (!key?.cloudAppId || (key.expiresAt && key.expiresAt <= new Date())) return null
    if (!(await this.memberships.findOne(key.organizationId, key.userId))) return null
    return { appId: key.cloudAppId, organizationId: key.organizationId, actor: `key:${key.name}` }
  }
}
