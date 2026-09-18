import { ExecutionContext, Injectable } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { Request } from 'express'

// Symbol identity cannot be forged by a client header or query parameter.
const organizationRegistrationRequest = Symbol('organizationRegistrationRequest')
type RegistrationRequest = Request & { [organizationRegistrationRequest]?: true }

export function isOrganizationRegistrationRequest(request: Request): boolean {
  return (request as RegistrationRequest)[organizationRegistrationRequest] === true
}

@Injectable()
export class OrganizationRegistrationGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RegistrationRequest>()
    request[organizationRegistrationRequest] = true
    return super.canActivate(context)
  }
}
