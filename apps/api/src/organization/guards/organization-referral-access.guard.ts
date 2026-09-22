import { ExecutionContext, Injectable } from '@nestjs/common'
import { isUUID } from 'class-validator'
import { OrganizationAccessGuard } from './organization-access.guard'
import { SystemRole } from '../../user/enums/system-role.enum'
import { RegistrationException } from '../../organization-referral/referral-code'

@Injectable()
export class OrganizationReferralAccessGuard extends OrganizationAccessGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    if (![SystemRole.USER, SystemRole.ADMIN].includes(request.user?.role) || !request.user?.userId) return false
    if (!isUUID(request.params.organizationId)) throw new RegistrationException(400, 'invalid_organization_id')
    return super.canActivate(context)
  }
}
