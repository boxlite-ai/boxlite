import { JwtStrategy } from './jwt.strategy'
import { SystemRole } from '../user/enums/system-role.enum'
import { UserService } from '../user/user.service'
import { TypedConfigService } from '../config/typed-config.service'

describe('JwtStrategy internal-admin allowlist seeding (POL-14)', () => {
  const options = {
    jwksUri: 'https://example.test/.well-known/jwks.json',
    audience: 'test-audience',
    issuer: 'test-issuer',
  }
  const allowlist = ['brianluo@polygala.ai']
  const req = { get: jest.fn(() => undefined) } as never

  function makeStrategy(user: { id: string; email: string; role: SystemRole }, adminEmails: string[]) {
    const userService = {
      findOne: jest.fn().mockResolvedValue({ ...user, emailVerified: true, name: 'Test' }),
      update: jest.fn().mockImplementation(async (_id: string, dto: Record<string, unknown>) => ({
        ...user,
        emailVerified: true,
        name: 'Test',
        ...dto,
      })),
      create: jest.fn(),
    }
    const configService = {
      get: jest.fn((key: string) => (key === 'internalAdminEmails' ? adminEmails : undefined)),
      getOrThrow: jest.fn(),
    }
    const strategy = new JwtStrategy(
      options,
      userService as unknown as UserService,
      configService as unknown as TypedConfigService,
    )
    return { strategy, userService }
  }

  it('promotes an allowlisted USER to ADMIN on login', async () => {
    const { strategy, userService } = makeStrategy(
      { id: 'u1', email: 'brianluo@polygala.ai', role: SystemRole.USER },
      allowlist,
    )
    const result = await strategy.validate(req, { sub: 'u1', email: 'brianluo@polygala.ai' })
    expect(userService.update).toHaveBeenCalledWith('u1', { role: SystemRole.ADMIN })
    expect(result.role).toBe(SystemRole.ADMIN)
  })

  it('does NOT promote a non-allowlisted user', async () => {
    const { strategy, userService } = makeStrategy(
      { id: 'u2', email: 'stranger@polygala.ai', role: SystemRole.USER },
      allowlist,
    )
    const result = await strategy.validate(req, { sub: 'u2', email: 'stranger@polygala.ai' })
    expect(userService.update).not.toHaveBeenCalledWith('u2', { role: SystemRole.ADMIN })
    expect(result.role).toBe(SystemRole.USER)
  })

  it('does not re-update an allowlisted user who is already ADMIN', async () => {
    const { strategy, userService } = makeStrategy(
      { id: 'u3', email: 'brianluo@polygala.ai', role: SystemRole.ADMIN },
      allowlist,
    )
    const result = await strategy.validate(req, { sub: 'u3', email: 'brianluo@polygala.ai' })
    expect(userService.update).not.toHaveBeenCalledWith('u3', { role: SystemRole.ADMIN })
    expect(result.role).toBe(SystemRole.ADMIN)
  })
})
