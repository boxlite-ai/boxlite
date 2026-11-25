import { Injectable, NotFoundException } from '@nestjs/common'
import { ApiKeyService } from '../api-key/api-key.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import type { AppCredentials } from './engine/ctx'

@Injectable()
export class CloudAppCredentials implements AppCredentials {
  constructor(
    private readonly keys: ApiKeyService,
    private readonly memberships: OrganizationUserService,
    private readonly organizations: OrganizationService,
  ) {}

  async authenticate(token: string) {
    const key = await this.keys.getApiKeyByValue(token).catch((error) => {
      if (error instanceof NotFoundException) return null
      throw error
    })
    if (!key) return null
    const canReadApps =
      (!key.expiresAt || key.expiresAt > new Date()) &&
      key.permissions.includes(Permission.READ_APPS) &&
      Boolean(await this.memberships.findOne(key.organizationId, key.userId)) &&
      (await this.organizations.getAppHostingPermissions(key.organizationId)).includes(Permission.READ_APPS)
    return { organizationId: key.organizationId, canReadApps }
  }
}
