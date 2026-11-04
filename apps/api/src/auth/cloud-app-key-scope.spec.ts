import 'reflect-metadata'
import { ExecutionContext, ForbiddenException } from '@nestjs/common'
import { CombinedAuthGuard } from './combined-auth.guard'

describe('App-scoped platform credentials', () => {
  class AppsController {}
  class BoxesController {}
  Reflect.defineMetadata('cloud-app-route', true, AppsController)
  const context = (controller: typeof AppsController) => ({ getClass: () => controller }) as ExecutionContext
  const guard = new CombinedAuthGuard()
  const user = { userId: 'owner', apiKey: { cloudAppId: 'app_crm' } }

  it('admits the credential only to the App management boundary', () => {
    expect(guard.handleRequest(null, user, undefined, context(AppsController))).toBe(user)
    expect(() => guard.handleRequest(null, user, undefined, context(BoxesController))).toThrow(ForbiddenException)
  })

  it('retains access for ordinary platform credentials', () => {
    const platformUser = { userId: 'owner', apiKey: {} }
    expect(guard.handleRequest(null, platformUser, undefined, context(BoxesController))).toBe(platformUser)
  })
})
