import { SetMetadata } from '@nestjs/common'

/** Routes whose authorization must see committed organization permissions on every request. */
export const CURRENT_ORGANIZATION_PERMISSIONS = 'currentOrganizationPermissions'
export const CurrentOrganizationPermissions = () => SetMetadata(CURRENT_ORGANIZATION_PERMISSIONS, true)
