import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'

/** Includes authentication and validation errors, which run before controller headers. */
@Injectable()
export class PrivateResponseGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store')
    return true
  }
}
